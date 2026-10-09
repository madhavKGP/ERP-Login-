// Shared by content.js and popup.js: fuzzy matching of security questions,
// so "dog name" finds "What is the name of your dog?".
// eslint-disable-next-line no-unused-vars
const ERPQL_MATCH = (() => {
  const STOP = new Set(
    'a an the is was are what which who whom where when how of your you my me to in on at for did do does s'.split(' ')
  );

  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const words = (s) => norm(s).split(' ').filter(Boolean);
  const keywords = (s) => {
    const all = words(s);
    const kw = all.filter((w) => !STOP.has(w));
    return new Set(kw.length ? kw : all);
  };

  // 0..1: how well a saved question matches the question shown on the page.
  function score(saved, shown) {
    const a = norm(saved), b = norm(shown);
    if (!a || !b) return 0;
    if (a === b) return 1;
    const K = keywords(a), S = keywords(b);
    let inter = 0;
    K.forEach((w) => { if (S.has(w)) inter++; });
    const containment = inter / (K.size || 1);
    const jaccard = inter / (K.size + S.size - inter || 1);
    return 0.7 * containment + 0.3 * jaccard;
  }

  // Best saved {q, a} entry for the shown question, or null.
  function findEntry(qa, shown) {
    let best = null, bestScore = 0;
    for (const item of qa || []) {
      if (!item || !item.q || !item.a) continue;
      const s = score(item.q, shown);
      if (s > bestScore) { bestScore = s; best = item; }
    }
    return bestScore >= 0.6 ? best : null;
  }

  const similar = (a, b) => score(a, b) >= 0.6 || score(b, a) >= 0.6;

  return { norm, score, findEntry, similar };
})();
