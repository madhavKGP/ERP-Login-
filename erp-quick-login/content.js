// ERP Quick Login - content script for erp.iitkgp.ac.in
// Fills User ID + password, waits for the security question, fills the matching
// answer, then presses "Get OTP". You only type the OTP and press Enter.
(() => {
  'use strict';

  const KEY = 'erpQuickLogin';
  const PENDING_KEY = 'erpQuickLoginPending';
  const DEFAULTS = {
    userId: '',
    password: '',
    qa: [],            // [{ q: 'question text', a: 'answer' }]
    seen: [],          // question texts seen on the login page (for the popup)
    autoFill: true,    // run as soon as the login page opens
    autoOtp: true,     // press Get OTP after filling
    autoClosePopup: true, // close the "OTP Sent!" dialog and focus the OTP box
  };
  const PENDING_MAX_AGE = 15 * 60 * 1000;

  const load = () =>
    new Promise((res) => chrome.storage.local.get(KEY, (o) => res({ ...DEFAULTS, ...((o && o[KEY]) || {}) })));
  const save = (cfg) => new Promise((res) => chrome.storage.local.set({ [KEY]: cfg }, res));

  const { norm, findEntry } = ERPQL_MATCH; // from match.js

  const byId = (id) => document.getElementById(id);
  const form = byId('loginForm');
  const uid = byId('user_id');
  const pwd = byId('password');
  const ans = byId('answer');
  const qLabel = byId('question');
  const qDiv = byId('answer_div');
  const otpBtn = byId('getotp');
  const otpIn = byId('email_otp1');
  const loginBtn = byId('loginFormSubmitButton');
  const isLoginPage = !!(form && uid && pwd && ans && qLabel && qDiv && otpBtn);

  // ---------------------------------------------------------------------------
  // Not the login page: if we just logged in, commit any answer learned there.
  // ---------------------------------------------------------------------------
  if (!isLoginPage) {
    chrome.storage.local.get(PENDING_KEY, async (o) => {
      const p = o && o[PENDING_KEY];
      if (!p) return;
      chrome.storage.local.remove(PENDING_KEY);
      if (!p.q || !p.a || Date.now() - p.ts > PENDING_MAX_AGE) return;
      const cfg = await load();
      if (!findEntry(cfg.qa, p.q)) {
        cfg.qa = [...cfg.qa, { q: p.q, a: p.a }];
        await save(cfg);
      }
    });
    chrome.runtime.onMessage.addListener((m, _s, reply) => {
      if (m && m.type === 'erpql-run') reply({ ok: false, reason: 'not-login-page' });
    });
    return;
  }

  // Back on the login page means the last attempt did not get through; drop it.
  chrome.storage.local.remove(PENDING_KEY);

  // ---------------------------------------------------------------------------
  // Small floating UI (shadow DOM so the site's CSS can't touch it)
  // ---------------------------------------------------------------------------
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      .wrap{font:13px/1.45 "Segoe UI",system-ui,-apple-system,Roboto,sans-serif;display:flex;flex-direction:column;align-items:flex-end;gap:8px}
      .msg{max-width:320px;padding:10px 12px;border-radius:10px;color:#fff;background:#1f2937;box-shadow:0 6px 20px rgba(0,0,0,.28);opacity:0;transform:translateY(6px);transition:opacity .2s,transform .2s;pointer-events:none}
      .msg.show{opacity:1;transform:none;pointer-events:auto}
      .msg.ok{background:#15803d}.msg.warn{background:#b45309}.msg.error{background:#b91c1c}
      button{all:unset;cursor:pointer;padding:8px 14px;border-radius:999px;background:#1e3c72;color:#fff;font-weight:600;box-shadow:0 4px 14px rgba(0,0,0,.28)}
      button:hover{background:#2a5298}
      button:focus-visible{outline:2px solid #93c5fd;outline-offset:2px}
    </style>
    <div class="wrap"><div class="msg" id="m" role="status" aria-live="polite"></div>
    <button id="b" title="Fill your details and press Get OTP">Quick login</button></div>`;
  document.body.appendChild(host);
  const msgEl = root.getElementById('m');
  let toastTimer;
  function toast(text, kind = 'info', ms = 5000) {
    msgEl.textContent = text;
    msgEl.className = 'msg show ' + kind;
    clearTimeout(toastTimer);
    if (ms) toastTimer = setTimeout(() => { msgEl.className = 'msg'; }, ms);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function setVal(el, v) {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // The question text currently on screen, or null if none is shown.
  function shownQuestion() {
    if (qDiv.classList.contains('d-none')) return null;
    const raw = (qLabel.textContent || '').replace(/\s+/g, ' ').trim();
    const n = norm(raw);
    return n && n !== 'security question' ? raw : null;
  }

  // Resolves after the page's security-question request finishes:
  // the question text, or null if the server said FALSE (bad User ID).
  function waitForQuestionResponse(timeout = 8000) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        obs.disconnect();
        clearTimeout(timer);
        resolve(v);
      };
      const obs = new MutationObserver(() => finish(shownQuestion()));
      obs.observe(qDiv, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true, characterData: true });
      const timer = setTimeout(() => finish(shownQuestion()), timeout);
    });
  }

  async function rememberSeen(q) {
    const c = await load();
    if ((c.seen || []).some((s) => norm(s) === norm(q))) return;
    c.seen = [...(c.seen || []), q].slice(-8);
    await save(c);
  }

  // Fill the answer for a question. Returns true if we knew the answer.
  function fillAnswer(q) {
    rememberSeen(q);
    const entry = findEntry(cfg.qa, q);
    if (entry) {
      setVal(ans, entry.a);
      return true;
    }
    toast(`New security question: "${q}". Type the answer yourself this time; it'll be remembered after you log in.`, 'warn', 14000);
    ans.focus();
    return false;
  }

  // ---------------------------------------------------------------------------
  // Main flow
  // ---------------------------------------------------------------------------
  let cfg = { ...DEFAULTS };
  let running = false;
  let lastQuestion = null;

  async function run() {
    if (running) return;
    running = true;
    try {
      cfg = await load();
      if (!cfg.userId || !cfg.password) {
        toast('Click the ERP Quick Login icon in the toolbar and save your User ID and password first.', 'warn', 8000);
        return;
      }
      setVal(uid, cfg.userId);
      setVal(pwd, cfg.password);

      const pending = waitForQuestionResponse();
      uid.dispatchEvent(new Event('blur')); // the page loads the question on blur
      const q = await pending;
      if (!q) {
        toast("The security question didn't load. Check the User ID saved in the extension, then click Quick login.", 'error', 9000);
        return;
      }
      lastQuestion = q;
      if (!fillAnswer(q)) return;

      if (!cfg.autoOtp) {
        toast('All filled. Press Get OTP.', 'ok');
        return;
      }
      if (otpBtn.disabled) {
        toast('All filled. Get OTP is cooling down; press it when the timer ends.', 'info', 7000);
        return;
      }
      otpBtn.click();
      toast('Filled and OTP requested. Check your email.', 'ok');
    } finally {
      running = false;
    }
  }

  // If the question changes later (e.g. you edit the User ID), refill the answer.
  new MutationObserver(() => {
    const q = shownQuestion();
    if (!q || q === lastQuestion) return;
    lastQuestion = q;
    if (!running) fillAnswer(q);
  }).observe(qDiv, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true, characterData: true });

  // Watch the site's SweetAlert dialogs ("OTP Sent!" / "Unable to Send OTP!").
  const handledPopups = new WeakSet();
  function focusOtpWhenDialogCloses() {
    const tryFocus = () => {
      if (document.querySelector('.swal2-container')) return false;
      if (otpIn) otpIn.focus();
      return true;
    };
    if (tryFocus()) return;
    const o = new MutationObserver(() => { if (tryFocus()) o.disconnect(); });
    o.observe(document.body, { childList: true });
    setTimeout(() => o.disconnect(), 120000);
  }
  new MutationObserver(() => {
    const popup = document.querySelector('.swal2-popup');
    if (!popup || handledPopups.has(popup)) return;
    const title = ((popup.querySelector('.swal2-title') || {}).textContent || '').toLowerCase();
    if (!title) return;
    handledPopups.add(popup);

    if (title.includes('otp sent')) {
      // Remember a newly typed answer; it's committed only after a successful login.
      const q = shownQuestion();
      if (q && ans.value && !findEntry(cfg.qa, q)) {
        chrome.storage.local.set({ [PENDING_KEY]: { q, a: ans.value, ts: Date.now() } });
      }
      if (cfg.autoClosePopup) {
        setTimeout(() => {
          const ok = popup.querySelector('.swal2-confirm');
          if (ok) ok.click();
        }, 600);
      }
      focusOtpWhenDialogCloses();
      toast('OTP sent. Type it in and press Enter.', 'ok', 8000);
    } else if (title.includes('unable')) {
      toast('OTP was not sent. Double-check the password and answers saved in the extension.', 'error', 10000);
    }
  }).observe(document.body, { childList: true, subtree: true });

  // Enter in the OTP box = Log In.
  if (otpIn && loginBtn) {
    otpIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && otpIn.value.trim()) {
        e.preventDefault();
        loginBtn.click();
      }
    });
  }

  root.getElementById('b').addEventListener('click', () => run());

  chrome.runtime.onMessage.addListener((m, _s, reply) => {
    if (m && m.type === 'erpql-run') {
      run();
      reply({ ok: true });
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEY]) cfg = { ...DEFAULTS, ...(changes[KEY].newValue || {}) };
  });

  // Kick off automatically once the page's own scripts are ready.
  load().then((c) => {
    cfg = c;
    if (c.autoFill && c.userId && c.password) {
      setTimeout(run, 300);
    } else if (!c.userId || !c.password) {
      toast('ERP Quick Login: click the extension icon to save your details.', 'info', 6000);
    }
  });
})();
