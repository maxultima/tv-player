// Cista EPG logika bez DOMu a site — primo testovatelna (node:test).
// Aplikace (src/app.js) ji importuje; prototyp ma vlastni zjednodusenou kopii.

export const normName = (s) =>
  (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');

export const stripSuffix = (s) => s.replace(/(hd|fhd|uhd|4k|cz|sk)$/, '');

// Rucni aliasy, kdyz se nazev stanice a klic EPG prokazatelne lisi (doplnime dle hlaseni).
export const EPG_ALIASES = {};

export function epgKeyCandidates(name) {
  const out = [name];
  const alias = EPG_ALIASES[normName(name)];
  if (Array.isArray(alias)) out.push(...alias);
  else if (alias) out.push(alias);
  return out;
}

const indexCache = new WeakMap();

function buildIndex(epgByChannel) {
  const idx = [];
  for (const [k, v] of Object.entries(epgByChannel || {})) {
    const n = normName(k);
    idx.push({ norm: n, base: stripSuffix(n), rows: v });
  }
  return idx;
}

/** Najde EPG radky pro stanici: nejdriv presne id z playlistu, pak nazev/aliasy, pak fuzzy shoda. */
export function matchEpgRows(epgByChannel, stationName, stationId) {
  if (!epgByChannel || typeof epgByChannel !== 'object') return null;
  if (stationId && epgByChannel[stationId]) return epgByChannel[stationId];
  for (const cand of epgKeyCandidates(stationName)) {
    if (epgByChannel[cand]) return epgByChannel[cand];
  }
  let idx = indexCache.get(epgByChannel);
  if (!idx) {
    idx = buildIndex(epgByChannel);
    indexCache.set(epgByChannel, idx);
  }
  const n = normName(stationName);
  const b = stripSuffix(n);
  let best = null;
  let bestScore = 0;
  for (const c of idx) {
    let s = 0;
    if (c.norm === n) s = 100;
    else if (b.length >= 3 && c.base === b) s = 90;
    else if (n.length === 0 || c.norm.length === 0) s = 0;
    else {
      const ratio = Math.min(c.norm.length, n.length) / Math.max(c.norm.length, n.length);
      if (ratio >= 0.7) {
        if (c.norm.startsWith(n) || n.startsWith(c.norm)) s = 70;
        else if ((n.length >= 4 && c.norm.includes(n)) || (c.norm.length >= 4 && n.includes(c.norm))) s = 50;
      }
    }
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  return bestScore >= 50 ? best.rows : null;
}

/** Aktualni stav z casu (ne snapshot): bezici porad + progress, jinak dalsi, jinak null. */
export function liveState(rows, nowMs = Date.now()) {
  if (!Array.isArray(rows)) return null;
  for (const p of rows) {
    if (p.s <= nowMs && nowMs <= p.e2) {
      const pct = p.e2 > p.s ? Math.round(((nowMs - p.s) / (p.e2 - p.s)) * 100) : 0;
      return { now: p.title, pct: Math.max(0, Math.min(100, pct)), start: p.t, end: p.e };
    }
  }
  const next = rows.find((p) => p.e2 > nowMs);
  if (next) return { now: next.title + ' (od ' + next.t + ')', pct: 0, start: next.t, end: next.e };
  return null;
}

/** Prevede playlist API na stanice: jen tv s URL, se zachovanim id pro EPG. */
export function parseSltvPlaylist(j) {
  const out = [];
  const chs = (j && j.channels) || {};
  let i = 0;
  for (const [key, v] of Object.entries(chs)) {
    if (!v || typeof v !== 'object') continue;
    if (v.type && v.type !== 'tv') continue;
    if (!v.url) continue;
    out.push({
      eid: v.id || null,
      locked: !!(v.locked && v.locked !== 'none'),
      noAccess: v.locked === 'noAccess',
      name: v.name || key,
      ini: String(v.name || key).slice(0, 3).toUpperCase(),
      color: '#' + (((i * 7654321 + 0x224488) % 0xffffff).toString(16).padStart(6, '0')),
      logo: v.logoUrl || null,
      now: 'Živě',
      pct: 50,
      epg: [{ t: '--:--', title: 'Živě' }],
      streamUrl: v.url,
      drm: null,
    });
    i++;
  }
  return out;
}
