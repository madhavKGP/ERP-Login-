'use strict';

const KEY = 'erpQuickLogin';
const DEFAULTS = { userId: '', password: '', qa: [], seen: [], autoFill: true, autoOtp: true, autoClosePopup: true };

const $ = (id) => document.getElementById(id);
const { similar } = ERPQL_MATCH; // from match.js

const load = () => new Promise((res) => chrome.storage.local.get(KEY, (o) => res({ ...DEFAULTS, ...((o && o[KEY]) || {}) })));
const store = (cfg) => new Promise((res) => chrome.storage.local.set({ [KEY]: cfg }, res));

function status(text, kind = '') {
  const el = $('status');
  el.textContent = text;
  el.className = kind;
}

function wireToggle(btn) {
  btn.addEventListener('click', () => {
    const input = btn.previousElementSibling;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.textContent = show ? 'Hide' : 'Show';
  });
}

function addRow(q = '', a = '', fromErp = false) {
  const row = document.createElement('div');
  row.className = 'qa';
  row.innerHTML = `
    ${fromErp ? '<p class="tag">Shown on the ERP login page. Add your answer.</p>' : ''}
    <div class="top">
      <input type="text" class="q" placeholder="Question (e.g. name of your first school)" spellcheck="false">
      <button type="button" class="rm" aria-label="Remove question" title="Remove">&times;</button>
    </div>
    <div class="pw">
      <input type="password" class="a" placeholder="Answer" autocomplete="off" spellcheck="false">
      <button type="button" class="toggle" aria-label="Show answer">Show</button>
    </div>`;
  row.querySelector('.q').value = q;
  row.querySelector('.a').value = a;
  row.querySelector('.rm').addEventListener('click', () => row.remove());
  wireToggle(row.querySelector('.toggle'));
  $('qaList').appendChild(row);
  return row;
}

async function init() {
  if (window.innerWidth > 520) document.body.classList.add('tab');
  document.querySelectorAll('.toggle[data-for]').forEach(wireToggle);

  const cfg = await load();
  $('userId').value = cfg.userId;
  $('password').value = cfg.password;
  $('autoFill').checked = !!cfg.autoFill;
  $('autoOtp').checked = !!cfg.autoOtp;
  $('autoClosePopup').checked = !!cfg.autoClosePopup;

  cfg.qa.forEach((e) => addRow(e.q, e.a));
  // Questions the ERP has shown that don't have an answer yet.
  (cfg.seen || [])
    .filter((s) => !cfg.qa.some((e) => similar(e.q, s)))
    .forEach((s) => addRow(s, '', true));
  while ($('qaList').children.length < 3) addRow();

  $('addQa').addEventListener('click', () => addRow().querySelector('.q').focus());
  $('save').addEventListener('click', () => save());
  $('runNow').addEventListener('click', runNow);
}

async function save() {
  const qa = [];
  let bad = false;
  document.querySelectorAll('#qaList .qa').forEach((row) => {
    const q = row.querySelector('.q').value.trim();
    const a = row.querySelector('.a').value.trim();
    if (q && a) qa.push({ q, a });
    else if (a && !q) bad = true;
  });
  if (bad) {
    status('An answer is missing its question.', 'err');
    return false;
  }
  const userId = $('userId').value.trim();
  const password = $('password').value;
  const prev = await load();
  await store({
    ...prev,
    userId,
    password,
    qa,
    autoFill: $('autoFill').checked,
    autoOtp: $('autoOtp').checked,
    autoClosePopup: $('autoClosePopup').checked,
  });
  if (!userId || !password) status('Saved. Add your User ID and password to enable auto-fill.', 'err');
  else status(`Saved: ${qa.length} security answer${qa.length === 1 ? '' : 's'}.`, 'ok');
  return true;
}

async function runNow() {
  if (!(await save())) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return status('No active tab.', 'err');
  chrome.tabs.sendMessage(tab.id, { type: 'erpql-run' }, (res) => {
    if (chrome.runtime.lastError || !res) {
      status('Open the ERP login page in this tab first (reload it if it was already open).', 'err');
    } else if (!res.ok) {
      status("This ERP page isn't the login page.", 'err');
    } else {
      status('Filling the login page now.', 'ok');
      setTimeout(() => window.close(), 700);
    }
  });
}

init();
