// TV klient v0.1.0 — frontend logika (vanilla, bez bundleru).
// Bez demo dat: stanice existuji jen po prihlaseni. Startovaci logika viz restore().

import { normName, matchEpgRows, liveState, parseSltvPlaylist } from './lib/epg.js';
import { t, getLang, setLang, applyI18n } from './lib/i18n.js';
import { invoke as ipcInvoke, listen, hasTauri } from './ipc/commands.js';
import {
  VODAFONE_WIDEVINE_DRM_ID,
  VODAFONE_DMS_APP,
  VODAFONE_DMS_CVER,
  VODAFONE_BRAND_ID,
  bytesToB64,
  rsaEncryptPkcs1,
  parseDmsConfig,
  parseVodafoneChannels,
  parseVodafoneEpgObjects,
  buildVodafoneBookmarkBody,
  parseVodafoneLoginResponse,
  normalizeKalturaLogoUrl,
  buildVodafoneThumbUrl,
} from './lib/vodafone.js';

// Tauri v2: nativni je window.__TAURI_INTERNALS__.invoke; __TAURI__.invoke je zalozni.
// Diagnostika mostu (bezi i bez nej, vysledek cteme z localStorage na disku).
try {
  const di = { t: Date.now(), internals: typeof window.__TAURI_INTERNALS__, tauri: typeof window.__TAURI__ };
  try { di.internalsKeys = window.__TAURI_INTERNALS__ ? Object.keys(window.__TAURI_INTERNALS__).slice(0, 20).join(',') : '(none)'; }
  catch (e) { di.internalsKeys = 'ERR:' + (e && e.message); }
  try { di.tauriKeys = window.__TAURI__ ? Object.keys(window.__TAURI__).slice(0, 30).join(',') : '(none)'; }
  catch (e) { di.tauriKeys = 'ERR:' + (e && e.message); }
  try { di.tauriCore = (window.__TAURI__ && window.__TAURI__.core) ? Object.keys(window.__TAURI__.core).slice(0, 20).join(',') : '(none)'; }
  catch (e) { di.tauriCore = 'ERR'; }
  di.href = location.href;
  di.ua = navigator.userAgent;

} catch {}
const invoke = hasTauri ? ipcInvoke : null;

const $ = (s) => document.querySelector(s);
const stage = $('#stage'), video = $('#video');
const errToast = $('#errToast');

function log(msg, level = 'INFO', tag = 'APP') {
  console.debug('[tv]', msg);
  if (invoke) {
    invoke('app_log', { level, tag, msg: String(msg).slice(0, 500) }).catch(() => {});
  }
  try {
    const el = document.getElementById('actLog');
    if (!el) return;
    const t = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const d = document.createElement('div');
    d.innerHTML = '<span class="lt">' + p(t.getHours()) + ':' + p(t.getMinutes()) + ':' + p(t.getSeconds()) + '</span>' + String(msg).slice(0, 160);
    el.appendChild(d);
    while (el.children.length > 24) el.firstChild.remove();
    el.scrollTop = el.scrollHeight;
  } catch {}
}
function toast(msg, ms = 8000) {
  errToast.textContent = msg;
  errToast.style.display = 'block';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { errToast.style.display = 'none'; }, ms);
}

// ---------- trvala pamet (tauri store, fallback localStorage) ----------
const LS_KEY = 'tvklient.settings.v1';
let tauriStore = null; // rid (cislo zdroje) z plugin:store|load
async function storeInit() {
  if (!invoke) return false;
  try { tauriStore = await invoke('plugin:store|load', { path: 'settings.json' }); return true; }
  catch (e) { console.debug('[tv] store load selhal:', e); return false; }
}
async function storeGet(key) {
  // Mirror je vzdy nejcerstvejsi (synchronni zapis pri kazde zmene) — cte se prvni.
  // Pritomnost klice rozhoduje (i null je platna ulozena hodnota).
  try {
    const all = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    if (all && typeof all === 'object' && (key in all)) return all[key];
  } catch {}
  if (tauriStore !== null && tauriStore !== undefined) {
    try {
      const v = await invoke('plugin:store|get', { rid: tauriStore, key });
      return v ?? null;
    }
    catch (e) { console.debug('[tv] store get selhal:', e); }
  }
  return null;
}
let saveT = null;
// Vsechny zapisy jdou pres jednu frontu (zadna konkurence = zadne slepeniny v souboru).
let storeWriteQ = Promise.resolve();
function storeSerial(fn) {
  const p = storeWriteQ.then(() => fn());
  storeWriteQ = p.catch(() => {});
  return p.catch(() => {});
}
function storeMirrorSet(key, value) {
  try {
    const all = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    all[key] = value;
    localStorage.setItem(LS_KEY, JSON.stringify(all));
  } catch {}
}
async function storeSet(key, value) {
  storeMirrorSet(key, value); // synchronni zalozni kopie vzdy prvni
  if (tauriStore === null || tauriStore === undefined) return;
  await storeSerial(async () => {
    await invoke('plugin:store|set', { rid: tauriStore, key, value });
  });
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    storeSerial(() => invoke('plugin:store|save', { rid: tauriStore }));
  }, 400);
}
async function storeDelete(key) {
  try {
    const all = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    if (all && typeof all === 'object' && (key in all)) { delete all[key]; localStorage.setItem(LS_KEY, JSON.stringify(all)); }
  } catch {}
  if (tauriStore === null || tauriStore === undefined) return;
  await storeSerial(async () => {
    try { await invoke('plugin:store|delete', { rid: tauriStore, key }); } catch {}
  });
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    storeSerial(() => invoke('plugin:store|save', { rid: tauriStore }));
  }, 400);
}
function storeFlush() {
  try {
    clearTimeout(saveT);
    if (tauriStore !== null && tauriStore !== undefined && invoke) {
      invoke('plugin:store|save', { rid: tauriStore }).catch(() => {});
    }
  } catch {}
}

// ---------- HTTP bez CORS (Rust backend, fallback fetch pro dev v prohlizeci) ----------
const UA_VLC = 'VLC/3.0.18 LibVLC/3.0.18';
async function apiGet(url) {
  if (invoke) return await invoke('http_get', { url, userAgent: UA_VLC });
  const r = await fetch(url, { headers: { 'User-Agent': UA_VLC } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return await r.text();
}

// ---------- zdroje ----------
const SOURCES = [
  { id: 'sltv', name: 'SledováníTV', logo: 'assets/sltv-icon.jpg', chip: 'plain', loginUrl: 'https://sledovat.tv/welcome/login' },
  { id: 'oneplay', name: 'Oneplay', logo: 'assets/oneplay-icon.jpg', chip: 'plain', loginUrl: 'https://www.oneplay.cz/prihlaseni' },
  { id: 'vodafone', name: 'Vodafone TV', logo: 'data:image/svg+xml;utf8,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%20120%20120%27%3E%3Crect%20width=%27120%27%20height=%27120%27%20rx=%2714%27%20fill=%27%23e60000%27/%3E%3Ccircle%20cx=%2760%27%20cy=%2745%27%20r=%2724%27%20fill=%27%23ffffff%27/%3E%3Cpath%20d=%27M62%2028c-9%203-14%2010-14%2019%200%2010%207%2016%2015%2016%208%200%2014-6%2014-14%200-7-5-12-12-12-2%200-4%20.5-5%201.3%201-4.5%204.2-7.8%209-9.2L62%2028z%27%20fill=%27%23e60000%27/%3E%3Ctext%20x=%2760%27%20y=%2797%27%20text-anchor=%27middle%27%20font-family=%27system-ui,Segoe%20UI,sans-serif%27%20font-size=%2714%27%20font-weight=%27700%27%20fill=%27%23ffffff%27%3EVodafone%20TV%3C/text%3E%3C/svg%3E', chip: 'plain', loginUrl: 'https://www.vodafonetv.cz/' },
];
const srcOf = (id) => SOURCES.find((s) => s.id === (id || curSrc));

let curSrc = 'sltv';
let selIdx = 0;
let selBySrc = {}; // zapamatovany vyber stanice pro kazdy zdroj (preziti prepnuti i restartu)
let autoplayed = false, bootSelIdx = 0, bootSrc = 'sltv'; // autoplay probehne jen jednou a jen bez rucni zmeny
let favBySrc = { sltv: [], oneplay: [], vodafone: [] }; // oblibene STRIKTNE per-source: 'eid:<id>' | 'op:<id>' | 'vf:<id>' | 'name:<jmeno>'
const favKey = (st) => (st.eid ? 'eid:' + st.eid : st.opId ? 'op:' + st.opId : st.vfId ? 'vf:' + st.vfId : 'name:' + st.name);
const favList = () => favBySrc[curSrc] || (favBySrc[curSrc] = []);
function stationByFav(key) {
  const list = channels();
  if (typeof key !== 'string') return undefined;
  if (key.startsWith('eid:')) { const f = list.find((s) => s.eid && ('eid:' + s.eid) === key); if (f) return f; }
  else if (key.startsWith('op:')) { const f = list.find((s) => s.opId && ('op:' + s.opId) === key); if (f) return f; }
  else if (key.startsWith('vf:')) { const f = list.find((s) => s.vfId && ('vf:' + s.vfId) === key); if (f) return f; }
  else if (key.startsWith('name:')) { const f = list.find((s) => s.name === key.slice(5)); if (f) return f; }
  else { const f = list.find((s) => s.name === key); if (f) return f; }
  return undefined;
}
const favHas = (st) => favList().includes(favKey(st));
function findStationEverywhere(pred) {
  for (const src of ['sltv', 'oneplay', 'vodafone']) {
    const f = (liveChannels[src] || []).find(pred);
    if (f) return { src, st: f };
  }
  return null;
}
function migrateFavKeys(old) {
  // Stara pole byly holá jména (navic prejmenovana poskytovatelem) → nove stabilni klice per-source.
  // Poradi: exact sltv → fuzzy sltv (jednoznacny nejdelsi) → exact oneplay → zahodit s hlasenim.
  const out = { sltv: [], oneplay: [] }, dropped = [];
  const push = (src, k) => { if (!out[src].includes(k)) out[src].push(k); };
  for (const k of old) {
    if (typeof k !== 'string') continue;
    if (k.includes(':')) {
      const hit = findStationEverywhere((s) => favKey(s) === k);
      if (hit) push(hit.src, k); else dropped.push(k);
      continue;
    }
    let hit = (liveChannels.sltv || []).find((s) => s.name === k);
    if (hit) { push('sltv', favKey(hit)); continue; }
    const nb = normName(k);
    const cands = (liveChannels.sltv || [])
      .filter((s) => { const a = normName(s.name); return a && nb && (a.includes(nb) || nb.includes(a)); })
      .sort((a, b) => normName(b.name).length - normName(a.name).length);
    if (cands.length === 1 || (cands.length > 1 && normName(cands[0].name).length > normName(cands[1].name).length)) {
      push('sltv', favKey(cands[0])); continue;
    }
    hit = (liveChannels.oneplay || []).find((s) => s.name === k);
    if (hit) { push('oneplay', favKey(hit)); continue; }
    dropped.push(k);
  }
  return { out, dropped };
}
function favToggle(st) {
  const l = favList(), k = favKey(st), i = l.indexOf(k);
  if (i >= 0) l.splice(i, 1); else l.push(k);
  persistSoon();
}
let paused = false;
let everPlayed = false;
let liveChannels = { sltv: [], oneplay: [], vodafone: [] };  // jen realna data po prihlaseni
let epgBySrc = { sltv: {}, oneplay: {}, vodafone: {} };      // EPG STRIKTNE per-source, zadne sdileni klicu:
                                              // sltv: {stanice: [...]}, oneplay: {<channelId>: [...]}
let authMeta = { sltv: null, oneplay: null, vodafone: null }; // {logged, profileId?, profileName?, manual?, updatedAt}
let hls = null, dashPlayer = null;

const channels = () => liveChannels[curSrc] || [];
async function debugDump(tag, listOverride) {
  const list = listOverride || channels();
  if (!invoke) return;
  try {
    const epgKeys = Object.keys(epgBySrc.sltv);
    await invoke('debug_dump', {
      name: tag + '.json',
      content: JSON.stringify({
        t: new Date().toISOString(), src: curSrc, selIdx,
        epgKeys: epgKeys.length, epgKeysOp: Object.keys(epgBySrc.oneplay).length, epgSample: epgKeys.slice(0, 30),
        stations: list.map((s) => ({ name: s.name, eid: s.eid || null, url: !!s.streamUrl, locked: s.locked || null })),
        videoOn: video.classList.contains('on'), body: document.body.className,
      }),
    });
  } catch (e) { log('debug dump selhal: ' + (e?.message || e)); }
}
function epgRowsFor(st) {
  // Striktne per-source: kazdy zdroj jen svuj store.
  // Zadny fallback pres jmena mezi zdroji — cizi program je horsi nez zadny.
  if (st.opId) { const r = epgBySrc.oneplay[st.opId]; return r && r.length ? r : null; }
  if (st.vfEpgId) { const r = epgBySrc.vodafone[st.vfEpgId]; return r && r.length ? r : null; }
  return matchEpgRows(epgBySrc.sltv, st.name, st.eid);
}
/* Pripominky: zvonecek v radku poradu → v dany cas aplikace sama prepne (vcetne zdroje) a spusti.
   Klic = zdroj|kanal|porad (stabilni id), prošle (po konci poradu) se mazeji. Muze jich byt vic. */
let reminders = {};
const chanKeyOf = (st) => st.eid || st.opId || st.vfId || st.name;
const rowIdOf = (p) => p.id || (p.s ? 's' + p.s : 't' + p.t);
const remKey = (src, st, p) => src + '|' + chanKeyOf(st) + '|' + rowIdOf(p);
function toggleReminder(st, p, srcOverride) {
  const src = srcOverride || curSrc;
  const k = remKey(src, st, p);
  if (reminders[k]) { delete reminders[k]; log('⏰ připomínka zrušena: ' + p.title); }
  else {
    reminders[k] = { src, chan: chanKeyOf(st), id: rowIdOf(p), title: p.title, t: p.t, s: p.s || 0, e2: p.e2 || 0 };
    log('⏰ připomenutí: ' + st.name + ' – ' + p.title + ' (' + p.t + ')');
  }
  persistSoon();
  const cur = currentStation(); if (cur) renderEpg(cur);
  renderReminders();
}
const startingReminders = new Set();
function cleanupReminders() {
  // Prošlé bez špendlíku a bez naplánovaného stažení z archivu se mažou; připnuté a recordAfter zůstávají.
  const now = Date.now();
  let drop = 0;
  for (const k of Object.keys(reminders)) {
    const r = reminders[k];
    if (!r || !r.s) { delete reminders[k]; drop++; }
    else if (r.e2 && r.e2 <= now && !r.pinned && !r.recordAfter) { delete reminders[k]; drop++; }
  }
  if (drop) persistSoon();
  return drop;
}
async function fireReminder(key, r) {
  const wasPinned = !!r.pinned;
  if (wasPinned) { r.fired = true; persistSoon(); }
  else { delete reminders[key]; persistSoon(); }
  if (curSrc !== r.src) curSrc = r.src;
  const list = channels();
  const i = list.findIndex((s) => chanKeyOf(s) === r.chan);
  if (i < 0) {
    log('⏰ stanice už není v seznamu: ' + r.title);
    if (wasPinned && reminders[key]) { reminders[key].retryAt = Date.now() + 60e3; persistSoon(); }
    renderAll();
    return;
  }
  selIdx = i;
  renderAll();
  try { await applySelection(true); } catch {} // tiche: pri neuspechu drzi 'on' a zkousi watchdog
  toast('⏰ Přepínám na ' + list[i].name + ': ' + r.title, 8000);
  log('⏰ čas vypršel → přepínám na ' + list[i].name + ': ' + r.title);
  // Připnutý (seriál): hned naplánovat příští výskyt (živý záznam zůstává v reminders, dokud se nenajde další).
  if (wasPinned && reminders[key]) planNext(key, reminders[key]);
}
function checkReminders() {
  const now = Date.now();
  let changed = false;
  for (const [k, r] of Object.entries(reminders)) {
    if (!r || !r.s) { delete reminders[k]; changed = true; continue; }
    if (startingReminders.has(k)) continue;
    if (r.e2 && r.e2 <= now) {
      if (r.recordAfter && !r.fired) {
        // Stazeni z archivu po skonceni poradu (+ presah v minutach, funguje i po probuzeni PC ze spanku).
        const waitMs = Math.max(1, +recCfg.pad || 0) * 60000 + 30000;
        if (now >= r.e2 + waitMs && (!r.retryAt || now >= r.retryAt) && !activeRec[r.src]) {
          const st = (liveChannels[r.src] || []).find((s) => chanKeyOf(s) === r.chan);
          if (st) {
            const p = { id: r.id, t: r.t, s: r.s, e2: r.e2, title: r.title };
            startingReminders.add(k);
            startRecordingNow(r.src, st, p, true, true).then((ok) => {
              startingReminders.delete(k);
              const cur = reminders[k];
              if (!cur) return;
              if (ok) {
                if (cur.pinned) { cur.fired = true; delete cur.retryAt; planNext(k, cur); }
                else { delete reminders[k]; persistSoon(); const stNow = currentStation(); if (stNow) renderEpg(stNow); renderReminders(); }
              } else {
                cur.retryAt = Date.now() + 120e3;
                persistSoon();
              }
            }).catch(() => {
              startingReminders.delete(k);
              if (reminders[k]) { reminders[k].retryAt = Date.now() + 120e3; persistSoon(); }
            });
          }
        }
        continue;
      }
      if (r.pinned && (!r.retryAt || now >= r.retryAt)) {
        // Připnuté prošlé: zkusit automaticky přeplánovat.
        if (planNext(k, r)) changed = true;
      } else if (!r.pinned) { delete reminders[k]; changed = true; }
      continue;
    }
    if (r.s <= now && (!r.e2 || now < r.e2)) {
      if (r.fired) {
        if (r.pinned && (!r.retryAt || now >= r.retryAt)) {
          if (planNext(k, r)) changed = true;
        }
        continue;
      }
      if (r.recordAfter && !r.record) continue; // stazeni z archivu az po skonceni poradu — neprepinat behem vysilani
      if (activeRec[r.src]) continue; // probiha nahravani na stejnem zdroji → jiny plan nesmi bezet
      if (r.record) {
        if (r.retryAt && now < r.retryAt) continue;
        const st = (liveChannels[r.src] || []).find((s) => chanKeyOf(s) === r.chan);
        if (st) {
          const p = { t: r.t, s: r.s, e2: r.e2, title: r.title };
          startingReminders.add(k);
          startRecordingNow(r.src, st, p, false, true).then((ok) => {
            startingReminders.delete(k);
            const cur = reminders[k];
            if (!cur) return;
            if (ok) {
              if (cur.pinned) { cur.fired = true; delete cur.retryAt; planNext(k, cur); }
              else { delete reminders[k]; persistSoon(); const stNow = currentStation(); if (stNow) renderEpg(stNow); renderReminders(); }
            } else {
              cur.retryAt = Date.now() + 60e3;
              persistSoon();
            }
          }).catch(() => {
            startingReminders.delete(k);
            if (reminders[k]) { reminders[k].retryAt = Date.now() + 60e3; persistSoon(); }
          });
        }
        continue;
      }
      if (r.pinned) {
        // Pripnuto: hrat jen kdyz bezi jiny stream; jinak jen preplanovat (zustava v planu).
        const playing = video.classList.contains('on') && !paused && !video.paused && !video.ended;
        if (playing) fireReminder(k, r).catch(() => {});
        else { r.fired = true; if (planNext(k, r)) changed = true; else persistSoon(); }
      } else {
        // Jednorazove: spustit vzdy (i kdyz nic nehraje), pote zase odejit.
        fireReminder(k, r).catch(() => {});
      }
    }
  }
  if (changed) { persistSoon(); const st = currentStation(); if (st) renderEpg(st); renderReminders(); }
}
function logEpgCoverage() {
  // Jen SledovaniTV: vola se po jeho EPG; Oneplay ma vlastni kontrolu po svem loadu (jen log, zadny toast).
  const all = channels().filter((st) => !st.opId && !st.vfId);
  const miss = all.filter((st) => !epgRowsFor(st)).map((st) => st.name + (st.eid ? " [" + st.eid + "]" : " [bez id]"));
  log('EPG: ' + (all.length - miss.length) + '/' + all.length + ' stanic má program');
  if (miss.length) {
    log('EPG bez shody: ' + miss.join(', '));
    const sample = Object.keys(epgBySrc.sltv).slice(0, 8).join(', ');
    log('EPG klice napr.: ' + sample);
    toast('EPG se nepodařilo spárovat pro: ' + miss.join(', ') + ' | klíče např.: ' + sample, 14000);
  }
}
function liveInfo(st) {
  const rows = epgRowsFor(st);
  if (rows && rows.length) {
    if (rows[0] && rows[0].s) {
      const dyn = liveState(rows);
      if (dyn) return dyn;
    } else {
      const live = rows.find((p) => p.now);
      if (live) return { now: live.title, pct: live.pct, start: live.t, end: live.e };
      const next = rows[0];
      if (next && next.t) return { now: next.title + ' (od ' + next.t + ')', pct: 0, start: next.t };
    }
  }
  if (st.now) return { now: st.now, pct: st.pct };
  return { now: '', pct: null };
}

// ---------- geometrie okna (Rust prikazy, zadna zavislost na tvaru JS API) ----------
async function saveWinStateNow() {
  if (!invoke) return;
  try { await invoke('win_save'); } catch (e) { log('okno: ulozeni selhalo: ' + (e?.message || e)); }
}
async function winInfoExfil() {
  let payload = 'no-invoke';
  try {
    if (!invoke) return;
    const r = await invoke('win_info');
    payload = JSON.stringify({ t: new Date().toISOString(), win: r });
    await invoke('debug_dump', { name: 'wininfo.json', content: payload }).catch(() => {});
  } catch (e) { payload = 'ex:' + ((e && e.message) || e); }
  try { localStorage.setItem('tvklient.wininfo', payload); } catch {}
}
async function restoreWinGeometry() {
  // Rust setup geometrii uz obnovil; frontend jen overi a zaloguje vysledek.
  if (!invoke) return;
  try {
    const applied = await invoke('win_apply');
    const r = await invoke('win_info');
    log('okno: ' + (applied ? 'obnoveno' : 'vychozi geometrie') + ' ' + r.x + ',' + r.y + ' ' + r.w + 'x' + r.h);
  }
  catch (e) { log('okno: obnova selhala: ' + (e?.message || e)); }
}
document.getElementById('wMin').onclick = (e) => { e.stopPropagation(); if (invoke) invoke('win_minimize').catch(() => {}); };
document.getElementById('wMax').onclick = (e) => { e.stopPropagation(); if (invoke) invoke('win_maximize_toggle').catch(() => {}); };
document.getElementById('wClose').onclick = (e) => {
  e.stopPropagation();
  const recSrc = Object.keys(activeRec).find((k) => activeRec[k]);
  if (recSrc) { openStopRecModal(recSrc, true); return; }
  if (invoke) invoke('win_close').catch(() => {});
};
// Sbaleni zdroju: sipka vlevo v radce s napovedou; sbalene jen ikony (vybrany s cervenym rameckem).
let srcCollapsed = false;
function syncSrcCollapsed() {
  document.body.classList.toggle('srcCollapsed', srcCollapsed);
  document.getElementById('srcToggle').textContent = srcCollapsed ? '▸' : '▾';
}
document.getElementById('srcToggle').onclick = (e) => {
  e.stopPropagation();
  srcCollapsed = !srcCollapsed;
  syncSrcCollapsed(); persistSoon();
  log(srcCollapsed ? 'zdroje sbaleny (jen ikony)' : 'zdroje rozbaleny');
};
// Spustit pri startu Windows (HKCU\...\Run pres Rust backend).
const autostartChk = document.getElementById('autostartChk');
if (autostartChk && invoke) {
  invoke('autostart_get').then((on) => { autostartChk.checked = !!on; }).catch(() => {});
  autostartChk.addEventListener('change', async () => {
    const want = autostartChk.checked;
    try {
      const res = await invoke('autostart_set', { enabled: want });
      autostartChk.checked = !!res;
      log('spustit při startu: ' + (res ? 'zapnuto' : 'vypnuto'));
    } catch (err) {
      autostartChk.checked = !want;
      log('spustit při startu selhalo: ' + err);
    }
  });
}
// ---------- Nahravani (HLS -> .ts pres Rust backend) ----------
let recCfg = { codec: 'ts', pad: 10, dir: '', fmt: '{date}_{time}_{channel}_{title}' };
try { Object.assign(recCfg, JSON.parse(localStorage.getItem('tvklient.recCfg') || '{}')); } catch {}
const activeRec = { sltv: null, oneplay: null, vodafone: null };
const isLiveRec = (src) => !!(activeRec[src] && !activeRec[src].archiveDl);
let pendingCollisionAction = null, stopModalSrc = null, stopModalCloseApp = false;
function saveRecCfg() {
  try { localStorage.setItem('tvklient.recCfg', JSON.stringify(recCfg)); } catch {}
  storeSet('recCfg', recCfg);
}
function sanitizeFile(s) { return String(s || '').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '_'); }
function formatRecName(stName, title, startMs) {
  const d = startMs ? new Date(startMs) : new Date();
  const p = (n) => String(n).padStart(2, '0');
  const date = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  const time = p(d.getHours()) + '-' + p(d.getMinutes());
  const raw = (recCfg.fmt || '{date}_{time}_{channel}_{title}')
    .replace(/\{date\}/g, date)
    .replace(/\{time\}/g, time)
    .replace(/\{channel\}/g, sanitizeFile(stName))
    .replace(/\{title\}/g, sanitizeFile(title));
  const ext = (recCfg.codec && recCfg.codec !== 'ts') ? '.mp4' : '.ts';
  return sanitizeFile(raw) + ext;
}
function formatElapsed(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const p = (n) => String(n).padStart(2, '0');
  return p(Math.floor(s / 3600)) + ':' + p(Math.floor((s % 3600) / 60)) + ':' + p(s % 60);
}
function formatBytes(b) {
  const mb = (b || 0) / (1024 * 1024);
  if (mb >= 1024) return (mb / 1024).toFixed(2).replace('.', ',') + ' GB';
  return mb.toFixed(1).replace('.', ',') + ' MB';
}
function fmtHm(ms) {
  const d = new Date(ms), p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes());
}
function findRecCollisions(src, startMs, endMs, excludeKey) {
  const hits = [];
  const ar = activeRec[src];
  if (ar && startMs < ar.stopAt && ar.startMs < endMs) {
    hits.push({ active: true, label: 'Právě nahrává: ' + ar.station + ' – ' + ar.title + ' (' + ar.start + ' – ' + ar.end + ' +' + ar.pad + ' min)' });
  }
  const padMs = (+recCfg.pad || 0) * 60000;
  for (const [k, r] of Object.entries(reminders)) {
    if (k === excludeKey || r.src !== src || !r.s) continue;
    const baseEnd = r.e2 || (r.s + 3600000);
    const re = baseEnd + (r.record ? padMs : 0);
    if (startMs < re && r.s < endMs) {
      const st = (liveChannels[src] || []).find((s) => chanKeyOf(s) === r.chan);
      hits.push({
        key: k,
        label: (r.record ? '⏺ Nahrávání: ' : '⏰ Připomínka: ') + (st ? st.name : r.chan) + ' – ' + r.title +
          ' (' + fmtHm(r.s) + ' – ' + fmtHm(baseEnd) + (r.record ? ' +' + recCfg.pad + ' min' : '') + ')',
      });
    }
  }
  return hits;
}
function openCollisionModal(newDesc, hits, onReplace) {
  document.getElementById('recColNew').innerHTML = '<b>' + t('recColNew') + '</b><br>' + newDesc;
  document.getElementById('recColList').innerHTML = '<b>' + t('recColList') + '</b><br>' + hits.map((h) => '• ' + h.label).join('<br>');
  document.getElementById('btnRecColReplace').textContent = hits.some((h) => h.active) ? t('btnReplaceActive') : t('btnReplacePlan');
  pendingCollisionAction = onReplace;
  document.getElementById('recCollisionModal').classList.add('on');
}
function closeCollisionModal() {
  document.getElementById('recCollisionModal').classList.remove('on');
  pendingCollisionAction = null;
}
function openStopRecModal(src, closeApp = false) {
  const r = activeRec[src]; if (!r) return;
  stopModalSrc = src; stopModalCloseApp = closeApp;
  document.getElementById('recStopText').textContent = closeApp ? t('recStopTextClose') : t('recStopText');
  document.getElementById('recStopInfo').innerHTML =
    '<b>' + r.station + ' – ' + r.title + '</b><br>' +
    t('recStopRecorded') + ' ' + formatElapsed(r.elapsedSec) + ' (' + formatBytes(r.bytes) + ')<br>' +
    t('recStopFile') + ' <span style="font-family:Consolas,monospace">' + r.filePath + '</span>';
  document.getElementById('recStopModal').classList.add('on');
}
function closeStopRecModal() {
  document.getElementById('recStopModal').classList.remove('on');
  stopModalSrc = null; stopModalCloseApp = false;
}
async function stopRecordingNow(src, discard = false) {
  const r = activeRec[src];
  if (invoke) { try { await invoke('rec_stop', { src, discard: !!discard }); } catch {} }
  if (video) video.muted = appMuted;
  if (r && !discard && r.codec && r.codec !== 'ts' && invoke) {
    r.converting = true;
    r.archiveDl = true;
    r.convStartedAt = Date.now();
    renderAll();
    log('🎞 překódovávám nahrávku (' + r.codec + ')…');
    const totalSec = Math.max(1, Math.round(((r.baseEnd - r.startMs) / 1000) + (r.pad || 0) * 60));
    invoke('rec_transcode', { src, tsPath: r.tsPath, encoder: r.codec, totalSec })
      .then((outPath) => {
        log('⏹ nahrávka překódována a uložena: ' + outPath);
        toast('Nahrávka uložena: ' + outPath.split(/[\\/]/).pop(), 6000);
      })
      .catch((err) => { log('překódování selhalo (ponechán .ts): ' + err); })
      .finally(() => {
        if (activeRec[src] === r) activeRec[src] = null;
        renderAll();
        checkReminders();
      });
    return;
  }
  activeRec[src] = null;
  renderAll();
  if (r) {
    if (discard) log('🗑 nahrávání zastaveno a zahozeno: ' + r.title);
    else log('⏹ nahrávání ukončeno a uloženo: ' + r.filePath);
  }
  checkReminders();
}
async function startRecordingNow(src, st, p, fromStart = false, quiet = false) {
  if (!invoke) return false;
  if (st.drm) return false;
  if (st.vfId) {
    if (!quiet) toast('Vodafone TV používá DRM ochranu — nahrávání není podporováno.');
    log('nahrávání: Vodafone TV DRM stream nelze nahrávat (' + st.name + ')');
    return false;
  }
  let url = fromStart ? await fetchTimeshiftUrl(st, p).catch(() => null) : st.streamUrl;
  if (!url && st.opId) {
    try {
      const tok = await oneplayToken();
      const m = await oneplayPlayUrl(tok, st.opId);
      if (m.dashDrm && !m.hls) { log('nahrávání: DRM stream nelze nahrávat (' + st.name + ')'); return false; }
      url = m.hls || m.dash;
      if (url) st.streamUrl = url;
    } catch (e) { log('nahrávání selhalo (URL): ' + (e?.message || e)); return false; }
  } else if (!url) {
    url = await fetchStreamUrl(st).catch(() => null);
  }
  if (!url) { if (!quiet) toast('Nepodařilo se získat stream pro nahrávání.'); return false; }
  const dir = recCfg.dir || await invoke('default_rec_dir').catch(() => '.');
  if (!recCfg.dir) { recCfg.dir = dir; const de = document.getElementById('recDir'); if (de) de.value = dir; saveRecCfg(); }
  const startMs = p.s || Date.now();
  const baseEnd = p.e2 || (startMs + 3600000);
  const pad = +recCfg.pad || 0;
  const stopAt = baseEnd + pad * 60000;
  const codec = recCfg.codec || 'ts';
  const file = formatRecName(st.name, p.title || 'Zaznam', startMs);
  const tsFile = file.replace(/\.mp4$/i, '.ts');
  const baseDir = dir.replace(/[\\/]+$/, '');
  const tsPath = baseDir + '\\' + tsFile;
  const filePath = baseDir + '\\' + file;
  let extraUrl = null;
  const extraSecs = (fromStart && pad > 0) ? (pad * 60) : 0;
  if (extraSecs > 0 && p && p.e2) {
    const rows = epgRowsFor(st) || [];
    const nextP = rows.find((x) => x.s >= p.e2 - 60000 && x.s <= p.e2 + 120000 && x.id && x.id !== p.id);
    if (nextP && canTimeshiftProg(st, nextP)) {
      extraUrl = await fetchTimeshiftUrl(st, nextP).catch(() => null);
    }
  }
  try {
    await invoke('rec_start', { src, url, filePath: tsPath, fromStart: !!fromStart, extraUrl, extraSecs: extraUrl ? extraSecs : 0 });
  } catch (e) {
    if (!quiet) toast('Nahrávání se nepodařilo spustit: ' + e);
    log('rec_start chyba: ' + e);
    return false;
  }
  const archiveDl = !!(fromStart && baseEnd <= Date.now());
  activeRec[src] = {
    src, station: st.name, ini: st.ini, color: st.color, logo: st.logo || null, img: p.img || null,
    title: p.title || st.name, start: p.t || fmtHm(startMs), end: fmtHm(baseEnd),
    startMs, baseEnd, stopAt, pad, codec, tsPath, fromStart: !!fromStart, archiveDl, elapsedSec: 0, bytes: 0, filePath, streamHidden: false,
  };
  if (src === curSrc && !archiveDl) {
    const si = channels().findIndex((x) => chanKeyOf(x) === chanKeyOf(st));
    if (si >= 0) selIdx = si;
    document.body.classList.remove('leftOpen');
    paused = false;
    applySelection(true);
  }
  renderAll();
  log((archiveDl ? '⬇ stahuji z archivu na pozadí: ' : '⏺ spuštěno nahrávání: ') + st.name + ' – ' + (p.title || '') + ' → ' + file);
  return true;
}
function toggleRecordFor(st, p, srcOverride, fromStart = false) {
  if (!st || st.drm) return;
  const src = srcOverride || curSrc;
  const k = remKey(src, st, p);
  const nowMs = Date.now();
  const isNow = p.s ? (p.s <= nowMs && nowMs <= (p.e2 || nowMs + 1)) : !!p.now;
  const isPastArchive = !!(fromStart && p.e2 && p.e2 <= nowMs);
  const startMs = p.s || nowMs;
  const baseEnd = p.e2 || (startMs + 3600000);
  const padMs = (+recCfg.pad || 0) * 60000;
  if (isPastArchive) {
    // Stahovani z archivu nikdy nekoliduje: pokud je zdroj volny, spusti se hned; jinak se zaradi do fronty a spusti po dokonceni.
    if (activeRec[src]) {
      const prev = reminders[k] || {};
      reminders[k] = { ...prev, src, chan: chanKeyOf(st), id: p.id || ('s' + p.s), s: p.s, e2: p.e2, t: p.t, title: p.title, recordAfter: true };
      persistSoon(); renderAll();
      log('⬇ zařazeno do fronty stažení z archivu: ' + st.name + ' – ' + p.title);
    } else {
      startRecordingNow(src, st, p, true);
    }
    return;
  }
  if (isNow) {
    if (activeRec[src] && activeRec[src].station === st.name && activeRec[src].title === p.title) {
      openStopRecModal(src, false);
      return;
    }
    const hits = findRecCollisions(src, startMs, baseEnd + padMs, k);
    const desc = '⏺ ' + st.name + ' – ' + p.title + ' (' + fmtHm(startMs) + ' – ' + fmtHm(baseEnd) + ' +' + recCfg.pad + ' min)';
    if (hits.length) {
      openCollisionModal(desc, hits, async () => {
        if (activeRec[src]) await stopRecordingNow(src);
        hits.forEach((h) => { if (h.key) delete reminders[h.key]; });
        persistSoon();
        await startRecordingNow(src, st, p, fromStart);
      });
      return;
    }
    startRecordingNow(src, st, p, fromStart);
    return;
  }
  if (reminders[k] && reminders[k].record) {
    reminders[k].record = false;
    persistSoon(); renderAll();
    log('⏺ nahrávání zrušeno u plánu: ' + p.title);
    return;
  }
  const hits = findRecCollisions(src, startMs, baseEnd + padMs, k);
  const desc = '⏺ ' + st.name + ' – ' + p.title + ' (' + fmtHm(startMs) + ' – ' + fmtHm(baseEnd) + ' +' + recCfg.pad + ' min)';
  const apply = () => {
    const prev = reminders[k] || {};
    reminders[k] = { ...prev, src, chan: chanKeyOf(st), s: p.s, e2: p.e2, t: p.t, title: p.title, record: true };
    persistSoon(); renderAll();
    log('⏺ naplánováno nahrávání: ' + st.name + ' – ' + p.title + ' (' + p.t + ')');
  };
  if (hits.length) {
    openCollisionModal(desc, hits, async () => {
      if (activeRec[src]) await stopRecordingNow(src);
      hits.forEach((h) => { if (h.key) delete reminders[h.key]; });
      apply();
    });
    return;
  }
  apply();
}
function renderRecPanel() {
  const r = isLiveRec(curSrc) ? activeRec[curSrc] : null;
  document.body.classList.toggle('recActive', !!r);
  document.body.classList.toggle('recStreamHidden', !!(r && r.streamHidden));
  if (video) video.muted = (r && r.streamHidden) ? true : appMuted;
  if (!r) return;
  const imgEl = document.getElementById('recThumb'), badgeEl = document.getElementById('recThumbBadge');
  if (r.img) { imgEl.src = r.img; imgEl.className = 'recThumb'; imgEl.style.display = 'block'; badgeEl.style.display = 'none'; }
  else if (r.logo) { imgEl.src = r.logo; imgEl.className = 'recThumb logo'; imgEl.style.display = 'block'; badgeEl.style.display = 'none'; }
  else { imgEl.style.display = 'none'; badgeEl.textContent = r.ini || ''; badgeEl.style.background = r.color || '#334155'; badgeEl.style.display = 'flex'; }
  const pct = r.baseEnd > r.startMs ? Math.max(0, Math.min(100, Math.round(((Date.now() - r.startMs) / (r.baseEnd - r.startMs)) * 100))) : 0;
  document.getElementById('recStName').textContent = r.station;
  document.getElementById('recProgTitle').textContent = r.title;
  document.getElementById('recProgTime').textContent = r.start + ' – ' + r.end + ' (+' + r.pad + ' min)';
  document.getElementById('recProgBar').style.width = pct + '%';
  document.getElementById('recElapsed').textContent = formatElapsed(r.elapsedSec);
  document.getElementById('recSize').textContent = formatBytes(r.bytes);
  const fp = document.getElementById('recFilePath');
  fp.textContent = r.filePath; fp.title = r.filePath;
  document.getElementById('btnRecHideStream').textContent = r.streamHidden ? t('showStream') : t('hideStream');
  document.getElementById('rhTitle').textContent = r.station + ' – ' + r.title;
  document.getElementById('rhSub').textContent = t('streamHiddenSub') + ' · ' + formatElapsed(r.elapsedSec) + ' · ' + formatBytes(r.bytes);
}
setInterval(async () => {
  if (!activeRec.sltv && !activeRec.oneplay && !activeRec.vodafone) return;
  if (invoke) {
    try {
      const st = await invoke('rec_status');
      const now = Date.now();
      for (const src of ['sltv', 'oneplay', 'vodafone']) {
        const r = activeRec[src];
        if (!r) continue;
        if (r.converting) {
          const c = st && st['conv_' + src];
          if (c) { r.convPct = c.pct || 0; r.convEtaSec = c.etaSec != null ? c.etaSec : null; }
          continue;
        }
        if (st && st[src]) {
          r.elapsedSec = st[src].elapsedSec || 0;
          r.activeSec = st[src].activeSec || 0;
          r.bytes = st[src].bytes || 0;
          r.segsDone = st[src].segsDone || 0;
          r.segsTotal = st[src].segsTotal || 0;
          r.reconnecting = !!st[src].reconnecting;
        } else if (r.fromStart && r.elapsedSec > 1) {
          // VOD/archivni stahovani skoncilo (#EXT-X-ENDLIST) -> dokoncit a prekodovat.
          await stopRecordingNow(src);
          continue;
        }
        if (!r.fromStart && r.stopAt && now >= r.stopAt) {
          await stopRecordingNow(src);
        }
      }
      if (isLiveRec(curSrc)) renderRecPanel();
      if (Object.values(activeRec).some((x) => x && x.archiveDl)) renderReminders();
    } catch {}
  }
}, 1000);
(function initRecUi() {
  const codecEl = document.getElementById('recCodec');
  const padEl = document.getElementById('recPad');
  const dirEl = document.getElementById('recDir');
  const fmtEl = document.getElementById('recFmt');
  const prevEl = document.getElementById('recPrev');
  function syncPrev() { if (prevEl) prevEl.textContent = 'Náhled: ' + formatRecName('ČT1', 'Události', Date.now()); }
  function applyUi() {
    if (codecEl && [...codecEl.options].some((o) => o.value === recCfg.codec)) codecEl.value = recCfg.codec;
    if (padEl) padEl.value = recCfg.pad;
    if (dirEl) dirEl.value = recCfg.dir;
    if (fmtEl) fmtEl.value = recCfg.fmt;
    syncPrev();
  }
  applyUi();
  if (invoke && codecEl) {
    invoke('rec_encoders').then((list) => {
      if (!Array.isArray(list) || !list.length) return;
      codecEl.innerHTML = '';
      list.forEach((enc) => {
        const opt = document.createElement('option');
        opt.value = enc.id; opt.textContent = enc.label;
        codecEl.appendChild(opt);
      });
      if (!list.some((e) => e.id === recCfg.codec)) recCfg.codec = list[0].id;
      applyUi();
    }).catch(() => {});
  }
  if (codecEl) codecEl.addEventListener('change', () => { recCfg.codec = codecEl.value; saveRecCfg(); syncPrev(); });
  storeGet('recCfg').then((v) => {
    if (v && typeof v === 'object') { Object.assign(recCfg, v); applyUi(); }
    if (!recCfg.dir && invoke) {
      invoke('default_rec_dir').then((d) => { if (d && !recCfg.dir) { recCfg.dir = d; applyUi(); saveRecCfg(); } }).catch(() => {});
    }
  }).catch(() => {});
  if (padEl) padEl.addEventListener('input', () => { recCfg.pad = Math.max(0, Math.min(120, +padEl.value || 0)); saveRecCfg(); });
  if (dirEl) dirEl.addEventListener('input', () => { recCfg.dir = dirEl.value; saveRecCfg(); });
  if (fmtEl) fmtEl.addEventListener('input', () => { recCfg.fmt = fmtEl.value; saveRecCfg(); syncPrev(); });
  const btnDir = document.getElementById('btnRecDir');
  if (btnDir) btnDir.onclick = async () => {
    if (!invoke) return;
    try {
      const picked = await invoke('pick_folder', { initial: recCfg.dir || null });
      if (picked) { recCfg.dir = picked; if (dirEl) dirEl.value = picked; saveRecCfg(); log('📁 složka nahrávek: ' + picked); }
    } catch (e) { log('výběr složky selhal: ' + e); }
  };
  document.querySelectorAll('#recTags .rcTag').forEach((tag) => {
    tag.onclick = () => {
      if (!fmtEl) return;
      const t = tag.dataset.tag;
      const s = fmtEl.selectionStart ?? fmtEl.value.length, e = fmtEl.selectionEnd ?? fmtEl.value.length;
      fmtEl.value = fmtEl.value.slice(0, s) + t + fmtEl.value.slice(e);
      recCfg.fmt = fmtEl.value; saveRecCfg(); syncPrev(); fmtEl.focus();
    };
  });
  document.getElementById('btnRecColCancel').onclick = closeCollisionModal;
  document.getElementById('btnRecColReplace').onclick = () => { const fn = pendingCollisionAction; closeCollisionModal(); if (fn) fn(); };
  document.getElementById('btnRecStopCancel').onclick = closeStopRecModal;
  document.getElementById('btnRecStopDiscard').onclick = async () => {
    const src = stopModalSrc, closeApp = stopModalCloseApp;
    closeStopRecModal();
    if (src) await stopRecordingNow(src, true);
    if (closeApp && invoke) invoke('win_close').catch(() => {});
  };
  document.getElementById('btnRecStopConfirm').onclick = async () => {
    const src = stopModalSrc, closeApp = stopModalCloseApp;
    closeStopRecModal();
    if (src) await stopRecordingNow(src);
    if (closeApp && invoke) invoke('win_close').catch(() => {});
  };
  document.getElementById('btnRecHideStream').onclick = () => {
    const r = activeRec[curSrc]; if (!r) return;
    r.streamHidden = !r.streamHidden;
    renderRecPanel();
    log(r.streamHidden ? '👁 stream skryt (nahrává na pozadí)' : '👁 stream zobrazen');
  };
  document.getElementById('btnRecStop').onclick = () => openStopRecModal(curSrc, false);
})();
// Hlasitost streamu: funkcni, pamatuje se.
let appVol = 80, appMuted = false;
function applyVol() {
  try {
    video.volume = Math.max(0, Math.min(1, appVol / 100));
    video.muted = appMuted;
  } catch {}
  const s = document.getElementById('volSlider'), v = document.getElementById('volVal'), ic = document.getElementById('volIco');
  if (s) s.value = appVol;
  if (v) v.innerHTML = appVol + '&nbsp;%';
  if (ic) ic.textContent = (appMuted || appVol === 0) ? '🔇' : '🔊';
}
document.getElementById('volSlider').addEventListener('input', (e) => {
  appVol = Math.max(0, Math.min(100, +e.target.value || 0));
  if (appVol > 0) appMuted = false;
  applyVol(); persistSoon();
});
document.getElementById('volSlider').addEventListener('change', () => log('hlasitost: ' + appVol + ' %'));
document.getElementById('volIco').onclick = () => {
  if (appMuted || appVol === 0) { appMuted = false; if (appVol === 0) appVol = 80; }
  else appMuted = true;
  applyVol(); persistSoon();
  log(appMuted ? 'ztlumeno' : 'hlasitost: ' + appVol + ' %');
};
document.getElementById('btnHelp').onmouseenter = (e) => {
  const pop = document.getElementById('helpPop');
  if (!pop) return;
  pop.classList.add('on');
  const panelW = document.getElementById('panelR').offsetWidth || 400;
  pop.style.left = Math.max(8, window.innerWidth - panelW - 10 - 520) + 'px';
  const r = e.target.getBoundingClientRect();
  const ph = pop.offsetHeight || 420;
  pop.style.top = Math.max(8, Math.min(r.top - 40, window.innerHeight - ph - 8)) + 'px';
};
document.getElementById('btnHelp').onmouseleave = () => {
  const pop = document.getElementById('helpPop');
  if (pop) pop.classList.remove('on');
};
document.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') { if (e.key !== 'Escape') return; }
  if (tag === 'button') return;
  if (e.key === ' ') { e.preventDefault(); if (currentStation()) togglePause(); }
  else if (e.key === 'f' || e.key === 'F') toggleMax();
  else if (e.key === 'Escape') { cancelBottomClose(); cancelTopClose(); document.body.classList.remove('rightOpen', 'leftOpen', 'bottomOpen', 'topOpen'); hideEpgPop(); hideProgDetail(); closeLoginModal(); closeCollisionModal(); closeStopRecModal(); }
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (isLiveRec(curSrc)) return;
    const list = channels();
    if (!list.length) return;
    selIdx = (selIdx + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
    applySelection(false);
  }
});
function watchWinState() {
  // Bez intervalu: Rust uklada pri presunu/zmeně velikosti, tady jen pri zavreni/skryti.
  window.addEventListener('beforeunload', () => { try { invoke && invoke('win_save'); } catch {} });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveWinStateNow(); });
}

// Detekce probuzeni ze sleepu + obecna detekce vypadku site s opakovany pokusem o pripojeni.
let lastTick = Date.now(), recovering = false, pendingWake = null;
let netOffline = false, netPollT = null, netAttempt = 0, netCountdown = 5, netProbing = false;
async function checkNetOnline() {
  if (!navigator.onLine) return false;
  if (!invoke) return navigator.onLine;
  try {
    return !!(await invoke('net_check'));
  } catch {
    return false;
  }
}
function updateOfflineMeta() {
  const meta = document.getElementById('offlineMeta');
  if (!meta) return;
  meta.textContent = netProbing
    ? t('netProbing', { n: netAttempt })
    : t('netAttempt', { n: netAttempt, s: netCountdown });
}
async function probeReconnect() {
  if (!netOffline || netProbing) return;
  netProbing = true;
  updateOfflineMeta();
  const ok = await checkNetOnline();
  netProbing = false;
  if (!netOffline) return;
  if (ok) {
    exitOffline();
  } else {
    netAttempt++;
    netCountdown = 5;
    updateOfflineMeta();
  }
}
function enterOffline(reason) {
  if (netOffline) return;
  netOffline = true;
  netAttempt = 1;
  netCountdown = 5;
  netProbing = false;
  document.body.classList.add('offline');
  updateOfflineMeta();
  log('výpadek sítě (' + reason + ') — zkouším se znovu připojit…');
  diag('enterOffline(' + reason + ')');
  clearInterval(netPollT);
  netPollT = setInterval(() => {
    if (!netOffline || netProbing) return;
    netCountdown--;
    if (netCountdown <= 0) probeReconnect();
    else updateOfflineMeta();
  }, 1000);
}
function exitOffline() {
  if (!netOffline) return;
  netOffline = false;
  clearInterval(netPollT); netPollT = null;
  document.body.classList.remove('offline');
  if (video.classList.contains('on')) { syncStageVideo(); }
  log('síť obnovena — spouštím obnovu…');
  diag('exitOffline()');
  wakeRecovery('net-back');
}
async function wakeRecovery(reason) {
  if (document.hidden || (!authMeta.sltv && !authMeta.oneplay && !authMeta.vodafone)) return;
  if (recovering) { pendingWake = reason; return; }
  recovering = true;
  diag('wakeRecovery(' + reason + ') start, online=' + navigator.onLine);
  try {
    if (!(await checkNetOnline())) {
      enterOffline(reason);
      return;
    }
    if (netOffline) {
      netOffline = false;
      clearInterval(netPollT); netPollT = null;
      document.body.classList.remove('offline');
    }
    log('probuzení (' + reason + ') — obnovuji…');
    const finishSrc = async (src) => {
      persistCache(); renderAll();
      if (curSrc !== src) return;
      const st = currentStation();
      diag('wakeRecovery(' + src + '): hotovo, st=' + (st ? st.name : '-') + ' paused=' + paused);
      if (st && !paused && (st.streamUrl || st.opId || st.vfId)) {
        await reloadQuiet();
        diag('wakeRecovery(' + src + '): reloadQuiet hotov');
      }
    };
    const jobs = [];
    if (authMeta.sltv && !authMeta.sltv.manual) jobs.push((async () => {
      try {
        const l = await withConnecting('sltv', sltvLoadChannels);
        if (l.length) { liveChannels.sltv = l; log('SledováníTV: kanály dohrány po probuzení'); }
      } catch (e) { log('obnova po probuzení (sltv): ' + (e?.message || e)); }
      await finishSrc('sltv');
    })());
    if (authMeta.oneplay && authMeta.oneplay.logged) jobs.push((async () => {
      try { await withConnecting('oneplay', () => oneplayEnsureEpg(true)); } catch (e) { log('obnova po probuzení (oneplay): ' + (e?.message || e)); }
      await finishSrc('oneplay');
    })());
    if (authMeta.vodafone && authMeta.vodafone.logged) jobs.push((async () => {
      try { await withConnecting('vodafone', () => vtvEnsureEpg(true)); } catch (e) { log('obnova po probuzení (vodafone): ' + (e?.message || e)); }
      await finishSrc('vodafone');
    })());
    await Promise.all(jobs);
  } finally {
    recovering = false;
    if (pendingWake) {
      const next = pendingWake; pendingWake = null;
      setTimeout(() => wakeRecovery(next), 200);
    }
  }
}
document.addEventListener('visibilitychange', () => {
  diag('visibility: ' + document.visibilityState + ' gap=' + Math.round((Date.now() - lastTick) / 1000) + 's');
  if (document.visibilityState !== 'hidden' && Date.now() - lastTick > 3 * 60e3) wakeRecovery('sleep');
});
window.addEventListener('online', () => {
  diag('online event');
  if (netOffline) probeReconnect();
  else wakeRecovery('online');
});
window.addEventListener('offline', () => { diag('offline event'); enterOffline('offline'); });
// Text poradu a progress se meni v case: kazdou minutu prekreslit, EPG dotahnout kazdych 15 minut.
// Hlidaci pes mrtveho streamu kazdych 10 s (minutovy prekres textu zustava na minute).
// Ma se hrat, ale video stoji → znovu od zive hrany, dokud se sit nevrati.
// DOCASNE: souborova diagnostika probuzeni (smazat po nalezu priciny)
let diagLog = [];
function diag(msg) {
  try {
    diagLog.push(new Date().toISOString().slice(11, 19) + ' ' + msg);
    if (diagLog.length > 200) diagLog.splice(0, diagLog.length - 200);
  } catch {}
}
setInterval(() => {
  if (!invoke) return;
  try {
    invoke('debug_dump', {
      name: 'wake-diag.json',
      content: JSON.stringify({
        t: new Date().toISOString(), hidden: document.hidden, paused,
        on: video.classList.contains('on'), vPaused: video.paused, ended: video.ended,
        ct: Math.round((video.currentTime || 0) * 10) / 10, rs: video.readyState, ns: video.networkState,
        online: navigator.onLine, err: video.error ? video.error.code : null,
        log: diagLog.slice(-60),
      }).slice(0, 20000),
    }).catch(() => {});
  } catch {}
}, 30000);
/* Zamer hrat (nezavisle na tride 'on'): watchdog zkousi, dokud skutecne nehraje.
   Nastavuje se pri kazdem pokusu o prehrani, maze pri skutecnem hrani / pauze / odhlaseni. */
let wantPlay = false;
video.addEventListener('playing', () => { wantPlay = false; });
// Hlidaci pes streamu je VYPNUTY na prani uzivatele — zustava jen kontrola pripominek.
setInterval(() => {
  checkReminders(); // pripominky i pri skrytem okne
}, 10000);
setInterval(() => {
  // Spánek bez změny viditelnosti (PC usnul s otevrenym oknem): velky skok casu = probuzeni.
  if (!document.hidden && Date.now() - lastTick > 3 * 60e3) wakeRecovery('sleep-tick');
  lastTick = Date.now();
  if (document.hidden || !currentStation()) return;
  // Pauza bez obrazu (treba boot bez site): zkouset pripravit, dokud to nevyjde.
  if (paused && !video.src) {
    if (!window.__pausedImgRetry || Date.now() - window.__pausedImgRetry > 60000) {
      window.__pausedImgRetry = Date.now();
      const pst = currentStation();
      if (pst) fetchStreamUrl(pst).then((url) => {
        if (url && paused && !video.src) { video.src = url; video.classList.add('on'); syncStageVideo(); renderStage(); log('obraz připraven (pauza, dodatečně)'); }
      }).catch(() => {});
    }
  }
  // Propadle Oneplay/Vodafone EPG dotahnout hned (necekat na 15min timer).
  if (!opEpgFresh()) oneplayEnsureEpg().then((n) => { if (n > 0) { persistCache(); renderAll(); } }).catch(() => {});
  if (!vtvEpgFresh()) vtvEnsureEpg().then((n) => { if (n > 0) { persistCache(); renderAll(); } }).catch(() => {});
  checkSnoozedWatches();
  renderStations(); renderStage();
}, 60000);
setInterval(() => {
  if (document.hidden) return;
  const jobs = [];
  if (authMeta.sltv && !authMeta.sltv.manual) {
    jobs.push((async () => {
      try {
        const list = await sltvLoadChannels();
        if (list.length) { liveChannels.sltv = list; persistCache(); renderAll(); log('EPG obnoveno (timer)'); }
      } catch (e) { log('EPG timer selhal: ' + (e?.message || e)); }
    })());
  }
  if (authMeta.oneplay && authMeta.oneplay.logged) {
    jobs.push((async () => {
      try {
        const n = await oneplayEnsureEpg(true);
        if (n > 0) { renderAll(); log('Oneplay EPG obnoveno (timer)'); }
      } catch (e) { log('Oneplay EPG timer selhal: ' + (e?.message || e)); }
    })());
  }
  if (authMeta.vodafone && authMeta.vodafone.logged) {
    jobs.push((async () => {
      try {
        const n = await vtvEnsureEpg(true);
        if (n > 0) { renderAll(); log('Vodafone TV EPG obnoveno (timer)'); }
      } catch (e) { log('Vodafone TV EPG timer selhal: ' + (e?.message || e)); }
    })());
  }
  if (jobs.length) Promise.allSettled(jobs);
}, 15 * 60 * 1000);
// ---------- video engine ----------
const STREAM_RATE_WIN_MS = 5000;
let streamRateSamples = []; // { ts, bytes }
let streamRateStartMs = 0;
let streamRateTimer = null;
function fmtStreamRate(bps) {
  if (!Number.isFinite(bps) || bps <= 0) return '↓ 0 KB/s';
  if (bps >= 1024 * 1024) return '↓ ' + (bps / (1024 * 1024)).toFixed(2) + ' MB/s';
  return '↓ ' + Math.round(bps / 1024) + ' KB/s';
}
function recordStreamBytes(bytes) {
  const b = Number(bytes);
  if (!Number.isFinite(b) || b <= 0) return;
  const now = Date.now();
  if (!streamRateStartMs) streamRateStartMs = now;
  streamRateSamples.push({ ts: now, bytes: b });
  updateStreamRateUi(now);
}
function updateStreamRateUi(nowMs) {
  const el = document.getElementById('streamRate');
  if (!el) return;
  const active = video.classList.contains('on');
  if (!active || !streamRateStartMs) {
    el.textContent = '';
    el.classList.remove('on');
    return;
  }
  const now = nowMs || Date.now();
  const cutoff = now - STREAM_RATE_WIN_MS;
  while (streamRateSamples.length && streamRateSamples[0].ts < cutoff) streamRateSamples.shift();
  if (!document.body.classList.contains('rightOpen')) return;
  let total = 0;
  for (let i = 0; i < streamRateSamples.length; i++) total += streamRateSamples[i].bytes;
  const spanSec = Math.max(1, Math.min(STREAM_RATE_WIN_MS / 1000, (now - streamRateStartMs) / 1000));
  el.textContent = fmtStreamRate(total / spanSec);
  el.classList.add('on');
}
function startStreamRateMeter() {
  streamRateSamples = [];
  streamRateStartMs = Date.now();
  if (!streamRateTimer) {
    streamRateTimer = setInterval(() => {
      if (!document.hidden && video.classList.contains('on') && document.body.classList.contains('rightOpen')) {
        updateStreamRateUi();
      }
    }, 1000);
  }
}
function resetStreamRateMeter() {
  streamRateSamples = [];
  streamRateStartMs = 0;
  if (streamRateTimer) { clearInterval(streamRateTimer); streamRateTimer = null; }
  const el = document.getElementById('streamRate');
  if (el) { el.textContent = ''; el.classList.remove('on'); }
}
function attachDashRateMeter(player) {
  const evs = window.dashjs?.MediaPlayer?.events;
  if (!player || !evs || !evs.FRAGMENT_LOADING_COMPLETED) return;
  player.on(evs.FRAGMENT_LOADING_COMPLETED, (ev) => {
    const b = ev?.response?.byteLength || ev?.request?.bytesLoaded || ev?.request?.bytesTotal || 0;
    if (b > 0) recordStreamBytes(b);
  });
}
function stopStream() {
  resetStreamRateMeter();
  vtvSsmStop().catch(() => {});
  try { video.pause(); } catch {}
  video.removeAttribute('src');
  try { video.load(); } catch {}
  if (hls) { try { hls.destroy(); } catch {} hls = null; }
  if (dashPlayer) { try { dashPlayer.reset(); } catch {} dashPlayer = null; }
  video.classList.remove('on');
  syncStageVideo();
}
// Stav prehravace na stage se musi synchronizovat V MOMENTE startu videa,
// ne jen v renderStage (ta bezi driv, nez video dostane 'on').
function syncStageVideo() {
  const hasVid = video.classList.contains('on');
  stage.classList.toggle('hasvideo', hasVid);
}
async function playStation(st, quiet = true, startPos = -1) {
  stopStream();
  if (!st?.streamUrl) { if (!quiet) renderIdle(); else { video.classList.add('on'); syncStageVideo(); } return; }
  const url = st.streamUrl;
  try {
    if (st.drm && st.drm.ssm && window.dashjs) {
      await vtvPrepareSsmForPlay(st);
      dashPlayer = dashjs.MediaPlayer().create();
      const prot = {
        'com.widevine.alpha': {
          priority: 0,
          serverURL: VTV_SSM_LICENSE_URL,
          sessionType: 'temporary',
          persistentState: 'required',
        },
      };
      if (vtvCfg && vtvCfg.wvCertB64) prot['com.widevine.alpha'].serverCertificate = vtvCfg.wvCertB64;
      dashPlayer.setProtectionData(prot);
      const evs = dashjs.MediaPlayer.events || {};
      const onDashErr = (kind) => (ev) => {
        const msg = (ev && (ev.error?.message || ev.error?.code || ev.event?.message || JSON.stringify(ev).slice(0, 180))) || kind;
        log('Vodafone ' + kind + ': ' + msg, 'ERROR', 'VTV');
        if (!quiet) toast('Vodafone TV: ' + msg, 10000);
      };
      if (evs.ERROR) dashPlayer.on(evs.ERROR, onDashErr('DASH ERROR'));
      if (evs.KEY_ERROR) dashPlayer.on(evs.KEY_ERROR, onDashErr('KEY_ERROR'));
      if (evs.KEY_SYSTEM_SELECTED) dashPlayer.on(evs.KEY_SYSTEM_SELECTED, (ev) => {
        if (ev?.error) onDashErr('KEY_SYSTEM_SELECTED')(ev);
        else log('Vodafone DRM keySystem selected', 'INFO', 'VTV');
      });
      if (evs.LICENSE_REQUEST_COMPLETE) dashPlayer.on(evs.LICENSE_REQUEST_COMPLETE, (ev) => {
        if (ev?.error) onDashErr('LICENSE_COMPLETE')(ev);
        else log('Vodafone DRM licence přijata OK', 'INFO', 'VTV');
      });
      let mpdLogged = false;
      if (evs.MANIFEST_LOADED) dashPlayer.on(evs.MANIFEST_LOADED, () => {
        if (!mpdLogged) { mpdLogged = true; log('Vodafone MPD manifest načten', 'INFO', 'VTV'); }
      });
      if (evs.PLAYBACK_STARTED) dashPlayer.on(evs.PLAYBACK_STARTED, () => log('Vodafone přehrávání běží → ' + st.name, 'INFO', 'VTV'));
      if (startPos > 0 && evs.PLAYBACK_METADATA_LOADED) {
        let sought = false;
        dashPlayer.on(evs.PLAYBACK_METADATA_LOADED, () => {
          if (sought) return;
          sought = true;
          try { dashPlayer.seek(startPos); } catch {}
        });
      }
      dashPlayer.initialize(video, url, !paused);
      attachDashRateMeter(dashPlayer);
      startStreamRateMeter();
      log('DASH+Widevine(SSM) → ' + st.name + ' (cert=' + (vtvCfg?.wvCertB64 ? vtvCfg.wvCertB64.length : 0) + ')', 'INFO', 'VTV');
    } else if (st.drm && window.dashjs) {
      dashPlayer = dashjs.MediaPlayer().create();
      dashPlayer.setProtectionData({ 'com.widevine.alpha': { serverURL: st.drm.licenceUrl } });
      dashPlayer.initialize(video, url, !paused);
      attachDashRateMeter(dashPlayer);
      startStreamRateMeter();
      log('DASH+Widevine → ' + st.name);
    } else if (/\.mpd(\?|$)/i.test(url) && window.dashjs) {
      dashPlayer = dashjs.MediaPlayer().create();
      dashPlayer.initialize(video, url, !paused);
      attachDashRateMeter(dashPlayer);
      startStreamRateMeter();
      log('DASH → ' + st.name);
    } else if (window.Hls && Hls.isSupported() && /\.m3u8(\?|$)/i.test(url)) {
      hls = new Hls({ enableWorker: true, startPosition: startPos });
      hls.loadSource(url);
      hls.attachMedia(video);
      startStreamRateMeter();
      hls.on(Hls.Events.FRAG_LOADED, (_e, data) => {
        const b = data?.frag?.stats?.loaded || data?.payload?.byteLength || 0;
        if (b > 0) recordStreamBytes(b);
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data?.fatal) return;
        log('HLS chyba: ' + (data.details || 'fatal'));
        if (data.type === 'networkError') {
          checkNetOnline().then((ok) => { if (!ok) enterOffline('hls-net'); });
        }
        if (quiet) { video.classList.add('on'); syncStageVideo(); } // drzet stav pro dalsi pokus
        else { toast('Stream se nepodařilo přehrát (' + (data.details || 'chyba') + ').'); renderIdle(); }
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (!paused) video.play().catch(() => { if (!quiet) { paused = true; renderStage(); } });
      });
      if (!paused) video.play().catch(() => {});
      log('HLS → ' + st.name);
    } else {
      video.src = url;
      if (!paused) await video.play().catch(() => { if (!quiet) { paused = true; renderStage(); } });
      log('nativní video → ' + st.name);
    }
    everPlayed = true;
    video.classList.add('on');
    syncStageVideo();
    persistSoon();
  } catch (e) {
    log('prehravani selhalo: ' + e);
    if (quiet) { video.classList.add('on'); syncStageVideo(); } // tichy rezim: drzet stav pro dalsi pokus
    else { toast('Stream se nepodařilo přehrát. Zkouším znovu po kliknutí na stanici.'); renderIdle(); }
  }
}
function renderIdle() {
  stopStream();
  renderStage();
}

// ---------- stage / panely ----------
function currentStation() {
  const list = channels();
  if (!list.length) return null;
  return list[Math.min(selIdx, list.length - 1)];
}
function renderStage() {
  const st = currentStation();
  stage.classList.toggle('empty', !st);
  const bi = $('#bigIcon');
  if (!st) {
    // Uprostred nic: jen sum, zadny nazev/ikona/progress.
    $('#epgHead').textContent = 'Program';
    $('#epg').innerHTML = '<div class="emptyNote">Zatím tu nic není. <b>Přihlas se ke zdroji</b> v pravém menu.</div>';
  } else {
    bi.textContent = st.ini; bi.style.background = st.color;
    $('#stageStation').textContent = st.name;
    const li = liveInfo(st);
    $('#stageProgram').textContent = 'Právě běží: ' + li.now;
    $('#stageProg').style.width = li.pct + '%';
    $('#epgHead').textContent = 'Program – ' + st.name;
    renderEpg(st);
  }
  const showPaused = paused && video.classList.contains('on');
  stage.classList.toggle('paused', showPaused);
  stage.classList.toggle('hasvideo', video.classList.contains('on'));
  renderBottomBar(st);
}
let inTimeshift = false, timeshiftProg = null, timeshiftBeginMs = 0, pendingSeekSec = null, playGen = 0;
function fmtHms(ms) {
  const d = new Date(ms), p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function syncTimeshiftUi() {
  document.body.classList.toggle('inTimeshift', inTimeshift);
  const lm = document.getElementById('nbLiveMark');
  if (!inTimeshift || !timeshiftProg || !timeshiftProg.s) {
    if (lm) lm.style.display = 'none';
    return;
  }
  const ct = pendingSeekSec !== null ? pendingSeekSec : (Number.isFinite(video.currentTime) ? video.currentTime : 0);
  const baseMs = timeshiftBeginMs || timeshiftProg.s;
  const curMs = baseMs + ct * 1000;
  const durMs = timeshiftProg.e2 > timeshiftProg.s ? (timeshiftProg.e2 - timeshiftProg.s) : 3600000;
  const pct = Math.max(0, Math.min(100, ((curMs - timeshiftProg.s) / durMs) * 100));
  const fill = document.getElementById('nbBarFill');
  if (fill) fill.style.width = pct.toFixed(1) + '%';
  const epgFill = document.querySelector('#epg .ep.now .epProg > div');
  if (epgFill) epgFill.style.width = pct.toFixed(1) + '%';
  if (lm && timeshiftProg.e2 > timeshiftProg.s) {
    const nowMs = Date.now();
    if (nowMs >= timeshiftProg.s && nowMs <= timeshiftProg.e2) {
      const livePct = Math.max(0, Math.min(100, ((nowMs - timeshiftProg.s) / (timeshiftProg.e2 - timeshiftProg.s)) * 100));
      lm.style.display = 'block';
      lm.style.left = livePct.toFixed(1) + '%';
    } else {
      lm.style.display = 'none';
    }
  }
  const tab = document.getElementById('nbStreamTab');
  if (tab) {
    const d = new Date(curMs), now = new Date();
    if (d.toDateString() !== now.toDateString()) {
      const days = t('days');
      const p2 = (n) => String(n).padStart(2, '0');
      tab.textContent = days[d.getDay()] + ', ' + p2(d.getDate()) + '.' + p2(d.getMonth() + 1) + '.' + d.getFullYear() + ' · ' + fmtHms(curMs);
    } else {
      tab.textContent = fmtHms(curMs);
    }
  }
}
function canTimeshiftProg(st, p) {
  if (!st || !p || !p.id) return false;
  if (st.opId) return !st.drm;
  if (st.vfId) return !st.locked && (p.canTimeshift === true);
  return (Number(st.timeshift) > 0) && (p.canTimeshift !== false);
}
async function fetchTimeshiftUrl(st, p) {
  if (!st || !p || !p.id) return null;
  if (st.vfId) {
    const m = await vtvPlayUrl(st, { epgId: p.id });
    if (!m || !m.url) return null;
    st._vtvPlay = m;
    st.drm = m.clearContent ? null : { ssm: true, token: m.drmToken || '' };
    return m.url;
  }
  if (st.opId) {
    const tok = await oneplayToken();
    const cid = String(p.id).includes('.') ? String(p.id) : ('epgitem.' + p.id);
    const post = {
      payload: { criteria: { schema: 'ContentCriteria', contentId: cid }, startMode: 'start' },
      playbackCapabilities: {
        protocols: ['dash', 'hls'], drm: ['widevine', 'fairplay'], altTransfer: 'Unicast',
        subtitle: { formats: ['vtt'], locations: ['InstreamTrackLocation', 'ExternalTrackLocation'] },
        liveSpecificCapabilities: { protocols: ['dash', 'hls'], drm: ['widevine', 'fairplay'], altTransfer: 'Unicast', multipleAudio: false },
      },
    };
    const data = await opCall('content.play', post, tok);
    const thumbTpl = data && data.media && data.media.images && data.media.images.thumbnailImageTemplate;
    if (thumbTpl) st.thumbTemplate = thumbTpl;
    const assets = ((((data || {}).media || {}).stream || {}).assets) || [];
    let hls = null, dash = null;
    for (const a of assets) {
      if (a.protocol === 'hls' && !a.drm && !hls) hls = a.src;
      else if (a.protocol === 'dash' && !a.drm && !dash) dash = a.src;
    }
    return hls || dash || null;
  }
  const sid = await sltvSession();
  if (!sid) return null;
  const d = await apiJson('https://sledovanitv.cz/api/event-timeshift?PHPSESSID=' + encodeURIComponent(sid) + '&eventId=' + encodeURIComponent(p.id) + '&format=m3u8&quality=40&capabilities=h264');
  return (d && d.url) || null;
}
async function playFromStart(st, p, seekSec = 0) {
  const gen = ++playGen;
  try {
    const url = await fetchTimeshiftUrl(st, p);
    if (gen !== playGen) return;
    if (!url) { toast('Pořad nelze přehrát od začátku.'); return; }
    const curSt = currentStation();
    if (!curSt || chanKeyOf(curSt) !== chanKeyOf(st)) {
      const si = channels().findIndex((x) => chanKeyOf(x) === chanKeyOf(st));
      if (si >= 0) {
        selIdx = si;
        selBySrc[curSrc] = st.name;
        renderFavs(); renderStations(); renderStage();
        persistSoon();
      }
    }
    inTimeshift = true;
    timeshiftProg = p ? { ...p } : null;
    const bm = /[?&]begin=(\d+)/.exec(url);
    timeshiftBeginMs = bm ? (+bm[1] * 1000) : (p && p.s ? p.s : Date.now());
    const adjSeek = (p && p.s && bm) ? Math.max(0, Math.round((p.s - timeshiftBeginMs) / 1000) + seekSec) : seekSec;
    pendingSeekSec = adjSeek;
    paused = false;
    renderBottomBar(st);
    renderEpg(st);
    syncTimeshiftUi();
    await playStation({ ...st, streamUrl: url }, false, adjSeek);
    if (gen !== playGen) return;
    const clearPending = () => { if (gen === playGen) { pendingSeekSec = null; syncTimeshiftUi(); } };
    if (adjSeek >= 0) {
      const doSeek = () => {
        try { video.currentTime = adjSeek; } catch {}
        video.addEventListener('seeked', clearPending, { once: true });
        setTimeout(clearPending, 1500);
      };
      if (video.readyState >= 1) doSeek();
      else video.addEventListener('loadedmetadata', doSeek, { once: true });
    } else {
      clearPending();
    }
    log('⏮ přehrávám od začátku' + (seekSec > 0 ? (' (+' + Math.round(seekSec) + ' s)') : '') + ': ' + (p.title || st.name));
  } catch (e) {
    if (gen !== playGen) return;
    pendingSeekSec = null;
    toast('Zpětné přehrání selhalo: ' + (e?.message || e));
    log('timeshift chyba: ' + (e?.message || e));
  }
}
function hideSeekPop() {
  const pop = document.getElementById('nbSeekPop');
  if (pop) pop.classList.remove('on');
}
let lastThumbUrl = '';
function updateSeekPop(bar, ev, p, st) {
  const pop = document.getElementById('nbSeekPop');
  const tab = document.getElementById('nbSeekTab');
  const img = document.getElementById('nbSeekImg');
  if (!pop || !tab) return null;
  const rect = bar.getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
  const startMs = (p && p.s) ? p.s : (Date.now() - 1800000);
  const endMs = (p && p.e2 && p.e2 > startMs) ? p.e2 : (startMs + 3600000);
  const targetMs = startMs + frac * (endMs - startMs);
  if (targetMs > Date.now()) {
    hideSeekPop();
    bar.style.cursor = 'default';
    return null;
  }
  bar.style.cursor = 'pointer';
  tab.textContent = fmtHms(targetMs);
  const tpl = st && st.thumbTemplate;
  if (tpl && img) {
    // Oneplay/CETIN Broadpeak epoch = 2015-01-01T00:00:00Z (1420070400 s), 10 s na snimek (+20 s korekce live latency).
    img.style.objectPosition = '';
    const thumbNum = Math.floor((targetMs / 1000 + 20 - 1420070400) / 10);
    const url = tpl.replace('{thumb}', String(thumbNum));
    if (url !== lastThumbUrl) {
      lastThumbUrl = url;
      img.onload = () => pop.classList.remove('timeOnly');
      img.onerror = () => pop.classList.add('timeOnly');
      img.src = url;
    }
  } else if (st && st.vfId && img) {
    // Vodafone TV Visual Scrubber: 10x1 horizontalni sprite pas (200 s / sprite, 20 s / snimek).
    const progId = p && p.id ? String(p.id) : null;
    let base = (st._vtvPlay && st._vtvPlay.assetType === 'epg' && st._vtvPlay.url) ? st._vtvPlay.url : null;
    if (!base && progId && st._vtvScrubber && st._vtvScrubber.progId === progId) base = st._vtvScrubber.url;
    if (!base && progId && (!st._vtvScrubberPending || st._vtvScrubberPending !== progId)) {
      st._vtvScrubberPending = progId;
      vtvPlayUrl(st, { epgId: progId }).then((m) => {
        if (m && m.url) st._vtvScrubber = { progId, url: m.url };
      }).catch(() => {}).finally(() => {
        if (st._vtvScrubberPending === progId) st._vtvScrubberPending = null;
      });
    }
    const info = base ? buildVodafoneThumbUrl(base, (targetMs - startMs) / 1000, 'CATCHUP') : null;
    if (info && info.url) {
      img.style.objectPosition = ((info.thumbIndex / 9) * 100).toFixed(4) + '% 50%';
      if (info.url !== lastThumbUrl) {
        lastThumbUrl = info.url;
        img.onload = () => pop.classList.remove('timeOnly');
        img.onerror = () => pop.classList.add('timeOnly');
        img.src = info.url;
      } else if (img.complete && img.naturalWidth > 0) {
        pop.classList.remove('timeOnly');
      }
    } else {
      pop.classList.add('timeOnly');
    }
  } else {
    pop.classList.add('timeOnly');
  }
  pop.style.left = Math.max(92, Math.min(window.innerWidth - 92, ev.clientX)) + 'px';
  pop.style.top = (rect.top - 10) + 'px';
  pop.classList.add('on');
  return { frac, durSec: (endMs - startMs) / 1000 };
}
function renderBottomBar(st) {
  if (!st) { cancelBottomClose(); document.body.classList.remove('bottomOpen'); return; }
  const rows = epgRowsFor(st) || [];
  const nowMs = Date.now();
  const p = (inTimeshift && timeshiftProg) ? timeshiftProg : (rows.find((r) => r.s && r.s <= nowMs && nowMs <= r.e2) || null);
  const li = liveInfo(st);
  const title = (p && p.title) || li.now || 'Bez programu';
  const pct = p && p.s && p.e2 > p.s
    ? Math.max(0, Math.min(100, Math.round(((nowMs - p.s) / (p.e2 - p.s)) * 100)))
    : (li.now ? li.pct : null);
  const imgEl = $('#nbImg'), badgeEl = $('#nbBadge');
  if (p && p.img) {
    imgEl.src = p.img; imgEl.className = ''; imgEl.style.display = 'block';
    badgeEl.style.display = 'none';
  } else if (st.logo) {
    imgEl.src = st.logo; imgEl.className = 'logo'; imgEl.style.display = 'block';
    badgeEl.style.display = 'none';
  } else {
    imgEl.removeAttribute('src'); imgEl.style.display = 'none';
    badgeEl.textContent = st.ini || ''; badgeEl.style.background = st.color || '#334155'; badgeEl.style.display = 'flex';
  }
  const srcName = (SOURCES.find((s) => s.id === curSrc) || {}).name || curSrc;
  $('#nbStation').textContent = st.name;
  $('#nbSrc').textContent = '· ' + srcName;
  $('#nbLive').style.display = (p || li.now) ? '' : 'none';
  $('#nbLive').textContent = inTimeshift ? 'ZPĚTNĚ' : 'ŽIVĚ';
  $('#nbTime').textContent = p && p.t ? (p.t + (p.e ? ' – ' + p.e : '')) : '';
  $('#nbTitle').textContent = title;
  const isRec = isLiveRec(curSrc);
  const canTs = canTimeshiftProg(st, p);
  const canSeek = canTs && !isRec;
  const bar = $('#nbBar');
  if (pct !== null) {
    bar.style.display = '';
    bar.classList.toggle('seekable', canSeek);
    bar.title = '';
    if (inTimeshift && timeshiftProg && timeshiftProg.s && timeshiftProg.e2 > timeshiftProg.s && Number.isFinite(video.currentTime)) {
      const curPct = Math.max(0, Math.min(100, (video.currentTime / ((timeshiftProg.e2 - timeshiftProg.s) / 1000)) * 100));
      $('#nbBarFill').style.width = curPct.toFixed(1) + '%';
    } else {
      $('#nbBarFill').style.width = pct + '%';
    }
    bar.onpointerenter = canSeek ? (ev) => updateSeekPop(bar, ev, p, st) : null;
    bar.onpointermove = canSeek ? (ev) => updateSeekPop(bar, ev, p, st) : null;
    bar.onpointerleave = hideSeekPop;
    bar.onpointerdown = bar.onpointerup = bar.onpointercancel = null;
    bar.onclick = canSeek ? (ev) => {
      ev.stopPropagation();
      const info = updateSeekPop(bar, ev, p, st);
      if (!info) return;
      $('#nbBarFill').style.width = (info.frac * 100).toFixed(1) + '%';
      const targetSec = Math.floor(info.frac * info.durSec);
      if (inTimeshift && video.seekable && video.seekable.length) {
        const baseMs = timeshiftBeginMs || (p && p.s) || 0;
        const adj = (p && p.s && timeshiftBeginMs) ? Math.max(0, Math.round((p.s - baseMs) / 1000) + targetSec) : targetSec;
        try { video.currentTime = adj; syncTimeshiftUi(); return; } catch {}
      }
      playFromStart(st, p, targetSec);
    } : null;
  } else {
    bar.style.display = 'none';
    bar.classList.remove('seekable');
    bar.onpointerenter = bar.onpointermove = bar.onpointerleave = bar.onpointerdown = bar.onpointerup = bar.onclick = null;
    hideSeekPop();
  }
  syncTimeshiftUi();
  $('#nbDesc').textContent = (p && p.desc) || t('noDesc');
  const fromStartBtn = document.getElementById('nbFromStartBtn');
  const liveBtn = document.getElementById('nbLiveBtn');
  const recStartBtn = document.getElementById('nbRecStartBtn');
  const recBtn = document.getElementById('nbRecBtn');
  const stopRecBtn = document.getElementById('nbStopRecBtn');
  if (fromStartBtn) {
    fromStartBtn.disabled = !canTs || isRec;
    fromStartBtn.onclick = (ev) => { ev.stopPropagation(); if (!fromStartBtn.disabled) playFromStart(st, p, 0); };
  }
  if (liveBtn) {
    const isLiveProg = !!(p && p.s && p.e2 && p.s <= nowMs && nowMs <= p.e2);
    liveBtn.disabled = !((canTs && inTimeshift && isLiveProg) || (paused && isLiveProg)) || isRec;
    liveBtn.onclick = (ev) => { ev.stopPropagation(); if (liveBtn.disabled) return; livePausedAtMs = 0; livePausedProg = null; inTimeshift = false; paused = false; applySelection(false); renderBottomBar(st); log('▶ přepnuto zpět na živé vysílání'); };
  }
  if (recStartBtn) {
    recStartBtn.disabled = !(canTs && !st.drm && !isRec);
    recStartBtn.onclick = (ev) => {
      ev.stopPropagation();
      if (recStartBtn.disabled) return;
      const prog = p || { t: fmtHm(nowMs), s: nowMs, e2: nowMs + 3600000, title: title || st.name, now: true };
      toggleRecordFor(st, prog, curSrc, true);
    };
  }
  if (recBtn) {
    recBtn.disabled = !(!st.drm && !isRec && !!p);
    recBtn.classList.toggle('on', isRec);
    recBtn.onclick = (ev) => {
      ev.stopPropagation();
      if (recBtn.disabled) return;
      const prog = p || { t: fmtHm(nowMs), s: nowMs, e2: nowMs + 3600000, title: title || st.name, now: true };
      toggleRecordFor(st, prog, curSrc, false);
    };
  }
  if (stopRecBtn) {
    stopRecBtn.disabled = !isRec;
    stopRecBtn.classList.toggle('on', isRec);
    stopRecBtn.onclick = (ev) => {
      ev.stopPropagation();
      if (stopRecBtn.disabled) return;
      openStopRecModal(curSrc, false);
    };
  }
}
function updateBottomClock() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const c = document.getElementById('nbClockTab');
  if (c) c.textContent = pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
  if (inTimeshift) syncTimeshiftUi();
}
updateBottomClock();
setInterval(() => { if (!document.hidden && document.body.classList.contains('bottomOpen')) updateBottomClock(); }, 1000);
let epgFilter = '';
let epgSearchOtherCh = true;
let epgSearchOtherSrc = false;
let epgSearchDesc = false;
const epgSearchVer = { sltv: 0, oneplay: 0, vodafone: 0 };
const epgWorkerSyncedVer = { sltv: -1, oneplay: -1, vodafone: -1 };
let epgSearchWorker = null;
let epgSearchJobId = 0;
let epgSearchDoneCb = null;
let epgSearchHideT = null;
function invalidateEpgSearch(src) {
  if (src) {
    if (epgSearchVer[src] !== undefined) epgSearchVer[src]++;
  } else {
    for (const k of Object.keys(epgSearchVer)) epgSearchVer[k]++;
  }
}
function setEpgSearchProgress(active, pct) {
  clearTimeout(epgSearchHideT);
  epgSearchHideT = null;
  const bar = document.getElementById('epgSearchProg');
  const fill = document.getElementById('epgSearchProgFill');
  if (!bar || !fill) return;
  if (active) {
    bar.classList.add('on');
    fill.style.width = Math.max(0, Math.min(100, pct || 0)) + '%';
  } else {
    bar.classList.remove('on');
    if (pct === 0) fill.style.width = '0%';
  }
}
function cancelEpgSearch() {
  epgSearchJobId++;
  epgSearchDoneCb = null;
  if (epgSearchWorker) {
    try { epgSearchWorker.postMessage({ type: 'cancel' }); } catch {}
  }
  setEpgSearchProgress(false, 0);
}
function getEpgSearchWorker() {
  if (epgSearchWorker) return epgSearchWorker;
  try {
    const w = new Worker(new URL('./lib/epg-search.worker.js', import.meta.url));
    w.onmessage = (ev) => {
      const msg = ev.data;
      if (!msg || msg.jobId !== epgSearchJobId) return;
      if (msg.type === 'progress') {
        const pct = msg.total > 0 ? Math.round((msg.done / msg.total) * 100) : 100;
        setEpgSearchProgress(true, Math.max(5, pct));
      } else if (msg.type === 'done') {
        setEpgSearchProgress(true, 100);
        epgSearchHideT = setTimeout(() => setEpgSearchProgress(false, 0), 180);
        const cb = epgSearchDoneCb;
        epgSearchDoneCb = null;
        if (cb) cb(msg);
      }
    };
    w.onerror = () => {
      try { w.terminate(); } catch {}
      if (epgSearchWorker === w) epgSearchWorker = null;
      setEpgSearchProgress(false, 0);
    };
    epgSearchWorker = w;
    return w;
  } catch {
    return null;
  }
}
function syncWorkerSources(srcIds, w) {
  for (const sid of srcIds) {
    if (epgWorkerSyncedVer[sid] === epgSearchVer[sid]) continue;
    const list = liveChannels[sid] || [];
    const chData = [];
    for (let i = 0; i < list.length; i++) {
      const ch = list[i];
      const rows = epgRowsFor(ch);
      if (!rows || !rows.length) continue;
      const slim = new Array(rows.length);
      for (let r = 0; r < rows.length; r++) {
        const p = rows[r];
        slim[r] = { i: r, t: p.title || '', d: p.desc || '', e2: p.e2 || 0, ts: canTimeshiftProg(ch, p) };
      }
      chData.push({ ck: chanKeyOf(ch), rows: slim });
    }
    w.postMessage({ type: 'sync', src: sid, channels: chData });
    epgWorkerSyncedVer[sid] = epgSearchVer[sid];
  }
}
function escHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function highlightMatch(text, rawQuery) {
  const src = String(text || '');
  const q = normName(rawQuery);
  if (!q) return escHtml(src);
  let norm = '';
  const map = [];
  for (let i = 0; i < src.length; i++) {
    const ch = src[i].normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    for (let j = 0; j < ch.length; j++) { norm += ch[j]; map.push(i); }
  }
  if (!norm) return escHtml(src);
  let out = '', pos = 0, from = 0;
  while (from < norm.length) {
    const hit = norm.indexOf(q, from);
    if (hit < 0) break;
    const origStart = map[hit];
    const origEnd = map[hit + q.length - 1] + 1;
    if (origStart > pos) out += escHtml(src.slice(pos, origStart));
    out += '<mark class="epgHl">' + escHtml(src.slice(origStart, origEnd)) + '</mark>';
    pos = origEnd;
    from = hit + q.length;
  }
  if (pos < src.length) out += escHtml(src.slice(pos));
  return out;
}
function epgMatchesQuery(p, q, inDesc) {
  if (!q) return true;
  if (p && p.title && normName(p.title).includes(q)) return true;
  if (inDesc && p && p.desc && normName(p.desc).includes(q)) return true;
  return false;
}
function syncEpgFilterClear() {
  const fi = document.getElementById('epgFilter'), b = document.getElementById('epgFilterClear');
  if (fi && b) b.classList.toggle('on', !!fi.value);
  const wb = document.getElementById('btnEpgWatch');
  if (wb) wb.disabled = normName(fi ? fi.value : '').length < 2;
}
function syncEpgFilterOpts() {
  const c1 = document.getElementById('epgOptOtherCh');
  const c2 = document.getElementById('epgOptOtherSrc');
  const c3 = document.getElementById('epgOptDesc');
  if (c1) c1.checked = epgSearchOtherCh !== false;
  if (c2) c2.checked = epgSearchOtherSrc === true;
  if (c3) c3.checked = epgSearchDesc === true;
}
/* ---------- Ulozena hlidani v EPG (scan plany + notifikace) ---------- */
let epgWatches = [];
const activeWatchNotifs = new Map(); // watchId|progKey -> { card, watchId }
const SNOOZE_24H_MS = 24 * 60 * 60 * 1000;
function describeWatchScope(w) {
  const srcName = (SOURCES.find((s) => s.id === w.src) || {}).name || w.src;
  let base;
  if (w.otherCh && w.otherSrc) base = t('epgWatchScopeAll');
  else if (w.otherCh) base = t('epgWatchScopeSrc', { src: srcName });
  else if (w.otherSrc) base = t('epgWatchScopeStOtherSrc', { st: w.station || '' });
  else base = t('epgWatchScopeStOnly', { st: w.station || '', src: srcName });
  return w.inDesc ? (base + ' · ' + t('epgWatchScopeDesc')) : base;
}
function formatWatchTime(s, e2, hmT, hmE) {
  if (!s) return hmT || '';
  const d = new Date(s), now = new Date();
  const tom = new Date(now.getTime() + 86400000);
  const dayStr = d.toDateString() === now.toDateString() ? t('today')
    : d.toDateString() === tom.toDateString() ? t('tomorrow')
    : shortDate(s);
  const startHm = hmT || fmtHm(s);
  const endHm = hmE || (e2 ? fmtHm(e2) : '');
  return dayStr + ' ' + startHm + (endHm ? (' – ' + endHm) : '');
}
function closeNotifsForWatch(watchId) {
  for (const [nk, entry] of activeWatchNotifs.entries()) {
    if (entry.watchId === watchId) {
      if (entry.card && entry.card.parentNode) entry.card.remove();
      activeWatchNotifs.delete(nk);
    }
  }
}
function renderEpgWatches() {
  const box = document.getElementById('epgWatchList');
  if (!box) return;
  box.classList.toggle('on', epgWatches.length > 0);
  box.innerHTML = '';
  if (!epgWatches.length) return;
  epgWatches.forEach((w) => {
    const row = document.createElement('div');
    row.className = 'epgWatchRow';
    row.title = t('epgWatchRowTip');
    row.innerHTML = '<span class="wi">🔔</span><span class="wt">' + w.q + '<small>' + describeWatchScope(w) + '</small></span><button class="wx" title="' + t('epgWatchDelTip') + '">×</button>';
    row.onclick = () => {
      const fi = document.getElementById('epgFilter');
      if (fi) fi.value = w.q;
      epgFilter = w.q;
      epgSearchOtherCh = !!w.otherCh;
      epgSearchOtherSrc = !!w.otherSrc;
      epgSearchDesc = !!w.inDesc;
      syncEpgFilterOpts();
      syncEpgFilterClear();
      const st = currentStation();
      if (st) renderEpg(st);
    };
    row.querySelector('.wx').onclick = (ev) => {
      ev.stopPropagation();
      epgWatches = epgWatches.filter((x) => x.id !== w.id);
      closeNotifsForWatch(w.id);
      persistSoon();
      renderEpgWatches();
      log('🔔 hlídání v EPG smazáno: „' + w.q + '“');
    };
    box.appendChild(row);
  });
}
let pendingWatchDraft = null;
function updateWatchModalSummary() {
  if (!pendingWatchDraft) return;
  const oCh = !!document.getElementById('wmOtherCh').checked;
  const oSrc = !!document.getElementById('wmOtherSrc').checked;
  const inDesc = !!document.getElementById('wmInDesc').checked;
  const draft = { ...pendingWatchDraft, otherCh: oCh, otherSrc: oSrc, inDesc };
  document.getElementById('wmSummary').innerHTML =
    '<div><b>' + t('epgWatchQueryLbl') + '</b> „' + draft.q + '“</div>' +
    '<div style="margin-top:4px;color:#cbd5e1"><b>' + t('epgWatchScopeLbl') + '</b> ' + describeWatchScope(draft) + '</div>';
}
function openEpgWatchModal() {
  const fi = document.getElementById('epgFilter');
  const q = (fi ? fi.value : '').trim();
  if (normName(q).length < 2) return;
  const st = currentStation();
  pendingWatchDraft = { q, station: st ? st.name : '', chan: st ? chanKeyOf(st) : '', src: curSrc };
  document.getElementById('wmOtherCh').checked = epgSearchOtherCh !== false;
  document.getElementById('wmOtherSrc').checked = epgSearchOtherSrc === true;
  document.getElementById('wmInDesc').checked = epgSearchDesc === true;
  updateWatchModalSummary();
  document.getElementById('epgWatchModal').classList.add('on');
}
function closeEpgWatchModal() {
  document.getElementById('epgWatchModal').classList.remove('on');
  pendingWatchDraft = null;
}
(function initEpgWatchUi() {
  const btn = document.getElementById('btnEpgWatch');
  if (btn) btn.onclick = openEpgWatchModal;
  const c1 = document.getElementById('wmOtherCh'), c2 = document.getElementById('wmOtherSrc'), c3 = document.getElementById('wmInDesc');
  if (c1) c1.onchange = updateWatchModalSummary;
  if (c2) c2.onchange = updateWatchModalSummary;
  if (c3) c3.onchange = updateWatchModalSummary;
  const cancel = document.getElementById('btnWmCancel');
  if (cancel) cancel.onclick = closeEpgWatchModal;
  const save = document.getElementById('btnWmSave');
  if (save) save.onclick = () => {
    if (!pendingWatchDraft) return;
    const w = {
      id: 'w-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      q: pendingWatchDraft.q,
      station: pendingWatchDraft.station,
      chan: pendingWatchDraft.chan,
      src: pendingWatchDraft.src,
      otherCh: !!document.getElementById('wmOtherCh').checked,
      otherSrc: !!document.getElementById('wmOtherSrc').checked,
      inDesc: !!document.getElementById('wmInDesc').checked,
      seen: {},
      snoozed: {},
    };
    epgWatches.push(w);
    persistSoon();
    renderEpgWatches();
    closeEpgWatchModal();
    const fi = document.getElementById('epgFilter');
    if (fi) fi.value = '';
    epgFilter = '';
    syncEpgFilterClear();
    const st = currentStation();
    if (st) renderEpg(st);
    log('🔔 uloženo hlídání v EPG: „' + w.q + '“ (' + describeWatchScope(w) + ')');
    scanEpgWatches();
  };
})();
function showEpgWatchNotification(w, m) {
  const stack = document.getElementById('epgNotifyStack');
  if (!stack) return;
  const nk = w.id + '|' + m.key;
  if (activeWatchNotifs.has(nk)) return;
  const card = document.createElement('div');
  card.className = 'epgNotif';
  const srcDef = SOURCES.find((s) => s.id === m.src) || SOURCES[0];
  const thumbHtml = m.img
    ? '<img class="epgNotifThumb" src="' + m.img + '" alt="">'
    : (m.logo
      ? '<img class="epgNotifThumb logo" src="' + m.logo + '" alt="">'
      : '<div class="epgNotifThumbBadge" style="background:' + (m.color || '#334155') + '">' + (m.ini || (m.station || '?').slice(0, 2)) + '</div>');
  const descHtml = m.desc ? '<div class="epgNotifDesc">' + m.desc + '</div>' : '';
  const timeTxt = formatWatchTime(m.s, m.e2, m.t, m.e);
  const mkBtn = (act, cls, label, enabled, disTip) =>
    '<button class="btn' + (cls ? ' ' + cls : '') + '" data-act="' + act + '"' + (enabled ? '' : ' disabled title="' + (disTip || '') + '"') + '>' + label + '</button>';
  card.innerHTML =
    '<div class="epgNotifTop"><span class="epgNotifTag">' + t('epgNotifTag') + '</span><button class="epgNotifClose" title="×">×</button></div>' +
    '<div class="epgNotifBody">' +
      thumbHtml +
      '<div class="epgNotifInfo">' +
        '<div class="epgNotifTitle">' + m.title + '</div>' +
        '<div class="epgNotifSrcRow"><img class="epgNotifLogo" src="' + srcDef.logo + '" alt="' + srcDef.name + '"><span>' + m.station + ' · ' + srcDef.name + ' · ' + timeTxt + ' · ' + t('epgNotifFilter', { q: w.q }) + '</span></div>' +
        descHtml +
      '</div>' +
    '</div>' +
    '<div class="epgNotifActions">' +
      '<div class="epgNotifGrp">' +
        mkBtn('open', 'primary', t('epgNotifOpen'), true) +
        mkBtn('rem', '', t('epgNotifSwitch'), true) +
        mkBtn('dl', '', t('epgNotifSaveDl'), !!m.canDl, t('epgNotifDlUnavail')) +
      '</div>' +
      '<div class="epgNotifGrp secondary">' +
        mkBtn('snooze', '', t('epgNotifSnooze'), true) +
        mkBtn('wait', '', t('epgNotifWaitNext'), true) +
        mkBtn('del', 'danger', t('epgNotifDelete'), true) +
      '</div>' +
    '</div>';
  const dismiss = () => {
    if (card.parentNode) card.remove();
    activeWatchNotifs.delete(nk);
  };
  const markSeen = () => {
    if (!w.seen || typeof w.seen !== 'object') w.seen = {};
    w.seen[m.key] = m.e2 || (Date.now() + 864e5);
    if (w.snoozed) delete w.snoozed[m.key];
    persistSoon();
  };
  const findStation = () => (liveChannels[m.src] || []).find((s) => chanKeyOf(s) === m.chan) || null;
  const progObj = () => ({ id: m.id, t: m.t, e: m.e, s: m.s, e2: m.e2, title: m.title, desc: m.desc, img: m.img });
  card.querySelector('.epgNotifClose').onclick = dismiss;
  card.querySelector('[data-act="open"]').onclick = () => {
    const list = liveChannels[m.src] || [];
    const si = list.findIndex((s) => chanKeyOf(s) === m.chan);
    if (m.src !== curSrc && si >= 0) curSrc = m.src;
    if (si >= 0) selIdx = si;
    document.body.classList.add('leftOpen');
    epgSearchOtherCh = !!w.otherCh;
    epgSearchOtherSrc = !!w.otherSrc;
    epgSearchDesc = !!w.inDesc;
    syncEpgFilterOpts();
    const fi = document.getElementById('epgFilter');
    if (fi) fi.value = w.q;
    epgFilter = w.q;
    syncEpgFilterClear();
    renderAll();
    const st = currentStation();
    if (st) renderEpg(st);
    markSeen();
    dismiss();
  };
  card.querySelector('[data-act="rem"]').onclick = () => {
    const st = findStation();
    const nowMs = Date.now();
    if (st) {
      if (m.s && m.s > nowMs) {
        const rk = remKey(m.src, st, progObj());
        if (!reminders[rk]) toggleReminder(st, progObj(), m.src);
      } else {
        const list = liveChannels[m.src] || [];
        const si = list.findIndex((s) => chanKeyOf(s) === m.chan);
        if (m.src !== curSrc) curSrc = m.src;
        if (si >= 0) { selIdx = si; renderAll(); applySelection(false); }
      }
    }
    markSeen();
    dismiss();
  };
  const dlBtn = card.querySelector('[data-act="dl"]');
  if (dlBtn && !dlBtn.disabled) dlBtn.onclick = () => {
    const st = findStation();
    if (st) {
      const p = progObj();
      const isPast = p.e2 && p.e2 <= Date.now();
      if (isPast) toggleRecordFor(st, p, m.src, true);
      else {
        const rk = remKey(m.src, st, p);
        if (!(reminders[rk] && reminders[rk].recordAfter)) toggleRecordAfter(st, p, m.src);
      }
    }
    markSeen();
    dismiss();
  };
  card.querySelector('[data-act="snooze"]').onclick = () => {
    if (!w.snoozed || typeof w.snoozed !== 'object') w.snoozed = {};
    w.snoozed[m.key] = { ...m, until: Date.now() + SNOOZE_24H_MS };
    persistSoon();
    log('🕒 upozornění odloženo o 24 h: „' + m.title + '“');
    dismiss();
  };
  card.querySelector('[data-act="wait"]').onclick = () => {
    markSeen();
    log('⏭ přeskočeno — hlídání „' + w.q + '“ čeká na další vysílání');
    dismiss();
  };
  card.querySelector('[data-act="del"]').onclick = () => {
    epgWatches = epgWatches.filter((x) => x.id !== w.id);
    closeNotifsForWatch(w.id);
    persistSoon();
    renderEpgWatches();
    log('🗑 hlídání v EPG odstraněno z notifikace: „' + w.q + '“');
  };
  activeWatchNotifs.set(nk, { card, watchId: w.id });
  stack.appendChild(card);
}
function cleanupEpgWatches() {
  const now = Date.now();
  let dirty = false;
  for (const w of epgWatches) {
    if (w.seen && typeof w.seen === 'object') {
      for (const [k, exp] of Object.entries(w.seen)) {
        if (!exp || exp <= now) { delete w.seen[k]; dirty = true; }
      }
    }
    if (w.snoozed && typeof w.snoozed === 'object') {
      for (const [k, entry] of Object.entries(w.snoozed)) {
        if (!entry || (entry.e2 && entry.e2 <= now)) { delete w.snoozed[k]; dirty = true; }
      }
    }
  }
  if (dirty) persistSoon();
}
function checkSnoozedWatches() {
  if (!epgWatches.length) return;
  const now = Date.now();
  let dirty = false;
  for (const w of epgWatches) {
    if (!w.snoozed || typeof w.snoozed !== 'object') continue;
    for (const [k, entry] of Object.entries(w.snoozed)) {
      if (!entry || (entry.e2 && entry.e2 <= now)) { delete w.snoozed[k]; dirty = true; continue; }
      if (entry.until && entry.until <= now) {
        delete w.snoozed[k];
        dirty = true;
        showEpgWatchNotification(w, entry);
      }
    }
  }
  if (dirty) persistSoon();
}
function scanEpgWatches(srcFilter) {
  if (!epgWatches.length) return;
  const now = Date.now();
  cleanupEpgWatches();
  for (const w of epgWatches) {
    const q = normName(w.q);
    if (q.length < 2) continue;
    const srcIds = w.otherSrc ? SOURCES.map((s) => s.id) : [w.src];
    for (const sid of srcIds) {
      if (srcFilter && sid !== srcFilter) continue;
      const list = liveChannels[sid] || [];
      for (const st of list) {
        if (sid === w.src && !w.otherCh && chanKeyOf(st) !== w.chan && st.name !== w.station) continue;
        const rows = epgRowsFor(st) || [];
        for (const p of rows) {
          if (!p || !p.title || (p.e2 && p.e2 <= now)) continue;
          if (!epgMatchesQuery(p, q, !!w.inDesc)) continue;
          const pk = remKey(sid, st, p);
          if (w.seen && w.seen[pk]) continue;
          if (w.snoozed && w.snoozed[pk] && w.snoozed[pk].until > now) continue;
          const canDl = !st.drm && canTimeshiftProg(st, p);
          showEpgWatchNotification(w, {
            key: pk, src: sid, chan: chanKeyOf(st), station: st.name,
            id: p.id || null, t: p.t || '', e: p.e || '', s: p.s || 0, e2: p.e2 || 0,
            title: p.title, desc: p.desc || '', img: p.img || null,
            logo: st.logo || null, color: st.color || '#334155', ini: st.ini || st.name.slice(0, 2),
            canDl,
          });
          break; // max 1 nejblizsi vyskyt na stanici a hlidani, at nezaplavi obrazovku
        }
      }
    }
  }
}
const DL_SVG = '<svg viewBox="0 0 16 16" width="13" height="13" style="vertical-align:-2px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><path d="M8 2v8m-3-3 3 3 3-3M3 13h10"/></svg>';
function toggleRecordAfter(st, p, srcOverride) {
  const src = srcOverride || curSrc;
  const k = remKey(src, st, p);
  if (reminders[k] && reminders[k].recordAfter) {
    delete reminders[k].recordAfter;
    if (!reminders[k].record && !reminders[k].pinned) delete reminders[k];
    log('stažení po skončení zrušeno: ' + p.title);
  } else {
    const prev = reminders[k] || {};
    reminders[k] = { ...prev, src, chan: chanKeyOf(st), id: p.id || ('s' + p.s), s: p.s, e2: p.e2, t: p.t, title: p.title, recordAfter: true };
    log('naplánováno stažení z archivu po skončení: ' + st.name + ' – ' + p.title);
  }
  persistSoon(); renderAll();
}
function renderEpg(st) {
  if (st && st.vfId && authMeta.vodafone && authMeta.vodafone.logged) {
    vtvLoadChannelEpg(st).then((n) => {
      if (n > 0 && currentStation() && chanKeyOf(currentStation()) === chanKeyOf(st)) renderStage();
    }).catch(() => {});
  }
  const sameSt = (renderEpg._for === st.name);
  if (!sameSt) { hideProgDetail(); renderEpg._hasScrolled = false; renderEpg._openedFor = null; epgFilter = ''; const fi = document.getElementById('epgFilter'); if (fi) fi.value = ''; syncEpgFilterClear(); cancelEpgSearch(); }
  renderEpg._for = st.name;
  const e = $('#epg');
  const prevScroll = sameSt ? e.scrollTop : -1;
  const live = epgRowsFor(st);
  const rows = live || (st.epg || []).map((p) => ({ t: p.t !== undefined ? p.t : p[0], title: p.title !== undefined ? p.title : p[1], now: !!(p.now !== undefined ? p.now : p[2]), pct: p.pct !== undefined ? p.pct : (p[3] || 10) }));
  if (!rows.length) { cancelEpgSearch(); e.innerHTML = '<div class="emptyNote">' + t('noEpg') + '</div>'; return; }
  const nowMs = Date.now();
  const q = normName(epgFilter);

  const renderMatches = (vis, otherChGroups, otherSrcGroups) => {
    e.innerHTML = '';
    let lastDay = null;
    let shown = 0;
    let nowEl = null, playEl = null;
    vis.forEach((p, idx) => {
      shown++;
      const day = p.day || (p.s ? new Date(p.s).toDateString() : null);
      if (day && day !== lastDay) {
        lastDay = day;
        const sep = document.createElement('div');
        sep.className = 'epDay';
        sep.textContent = dayLabel(p.s || nowMs);
        e.appendChild(sep);
      }
      const isNow = p.s ? (p.s <= nowMs && nowMs <= p.e2) : !!p.now;
      const isPast = p.e2 && p.e2 <= nowMs;
      const isTsPlaying = !!(inTimeshift && timeshiftProg && ((p.id && timeshiftProg.id && p.id === timeshiftProg.id) || (p.s && timeshiftProg.s && p.s === timeshiftProg.s && p.title === timeshiftProg.title)));
      const isPlaying = inTimeshift ? isTsPlaying : isNow;
      let pctBar = null;
      if (isPlaying && p.s && p.e2 > p.s) {
        const refMs = isTsPlaying
          ? ((timeshiftBeginMs || p.s) + (pendingSeekSec !== null ? pendingSeekSec : (Number.isFinite(video.currentTime) ? video.currentTime : 0)) * 1000)
          : nowMs;
        pctBar = Math.max(0, Math.min(100, Math.round(((refMs - p.s) / (p.e2 - p.s)) * 100)));
      }
      const d = document.createElement('div');
      d.className = 'ep' + (isPlaying ? ' now' : '') + (isPast ? ' past' : '');
      if (isNow) nowEl = d;
      if (isTsPlaying) playEl = d;
      // Bez nativniho title tooltipu — popis ukazuje plovouci detail.
      const marked = !!reminders[remKey(curSrc, st, p)];
      const recOn = !!(reminders[remKey(curSrc, st, p)] && reminders[remKey(curSrc, st, p)].record) || !!(activeRec[curSrc] && activeRec[curSrc].station === st.name && activeRec[curSrc].title === p.title);
      // Zvonecek jen u poradu, ktere jeste nezacaly (bezici/minule naplanovat nejde).
      const upcoming = p.s && p.s > nowMs;
      const canRecLive = !st.drm && (isNow || upcoming);
      const canDl = !st.drm && canTimeshiftProg(st, p) && (isPast || isNow || upcoming);
      const recAfterOn = !!(reminders[remKey(curSrc, st, p)] && reminders[remKey(curSrc, st, p)].recordAfter) || (isPast && !!(activeRec[curSrc] && activeRec[curSrc].station === st.name && activeRec[curSrc].title === p.title));
      d.innerHTML = '<span class="t">' + p.t + '</span><span class="ti">' + highlightMatch(p.title, epgFilter) + (isTsPlaying ? '<span class="live">' + t('timeshift') + '</span>' : (isNow ? '<span class="live">' + t('live') + '</span>' : '')) + '</span>'
        + (canDl ? '<span class="recBtn' + (recAfterOn ? ' on' : '') + ' recAfter" title="' + (isPast ? 'Stáhnout z archivu' : 'Stáhnout z archivu po skončení pořadu (PC může mezitím spát)') + '">' + DL_SVG + '</span>' : '')
        + (canRecLive ? '<span class="recBtn' + (recOn ? ' on' : '') + ' recLive" title="' + (isNow ? 'Nahrávat hned' : 'Naplánovat nahrávání') + '">⏺</span>' : '')
        + (upcoming ? '<span class="rem' + (marked ? ' on' : '') + '" title="Připomenout a v daný čas přepnout">⏰</span>' : '')
        + (isPlaying && pctBar !== null ? '<div class="epProg"><div style="width:' + pctBar + '%"></div></div>' : '');
      if (canDl) d.querySelector('.recAfter').onclick = (ev) => {
        ev.stopPropagation();
        if (isPast) toggleRecordFor(st, p, curSrc, true);
        else toggleRecordAfter(st, p);
      };
      if (canRecLive) d.querySelector('.recLive').onclick = (ev) => { ev.stopPropagation(); toggleRecordFor(st, p, curSrc, false); };
      if (upcoming) d.querySelector('.rem').onclick = (ev) => { ev.stopPropagation(); toggleReminder(st, p); };
      d.onclick = (ev) => {
        ev.stopPropagation();
        if (isPast && canTimeshiftProg(st, p)) {
          playFromStart(st, p, 0);
          return;
        }
        if (video.classList.contains('on')) {
          if (paused) { paused = false; resumeLive(); stage.classList.remove('paused'); persistSoon(); }
          return;
        }
        applySelection(false); log('stanice → ' + st.name + ' („' + p.title + '“)');
      };
      d.onmouseenter = () => scheduleProgDetail(d, st, vis, idx);
      d.onmouseleave = () => hideProgDetail();
      e.appendChild(d);
    });
    let otherShown = 0;
    const appendOtherChannel = (container, ost, targetSrc, oVis) => {
      const hd = document.createElement('div');
      hd.className = 'epOtherHead';
      const icoHtml = ost.logo
        ? '<img class="epOtherLogo" src="' + ost.logo + '" alt="">'
        : '<span class="epOtherIni" style="background:' + (ost.color || '#334155') + '">' + (ost.ini || ost.name.slice(0, 2)) + '</span>';
      hd.innerHTML = icoHtml + '<span>' + ost.name + '</span>';
      container.appendChild(hd);
      let oLastDay = null;
      oVis.forEach((p, idx) => {
        otherShown++;
        const day = p.day || (p.s ? new Date(p.s).toDateString() : null);
        if (day && day !== oLastDay) {
          oLastDay = day;
          const sep = document.createElement('div');
          sep.className = 'epDay';
          sep.textContent = dayLabel(p.s || nowMs);
          container.appendChild(sep);
        }
        const isNow = p.s ? (p.s <= nowMs && nowMs <= p.e2) : !!p.now;
        const isPast = p.e2 && p.e2 <= nowMs;
        const pctLive = p.s && p.e2 > p.s ? Math.max(0, Math.min(100, Math.round(((nowMs - p.s) / (p.e2 - p.s)) * 100))) : null;
        const d = document.createElement('div');
        d.className = 'ep' + (isNow ? ' now' : '') + (isPast ? ' past' : '');
        const marked = !!reminders[remKey(targetSrc, ost, p)];
        const recOn = !!(reminders[remKey(targetSrc, ost, p)] && reminders[remKey(targetSrc, ost, p)].record) || !!(activeRec[targetSrc] && activeRec[targetSrc].station === ost.name && activeRec[targetSrc].title === p.title);
        const upcoming = p.s && p.s > nowMs;
        const canRecLive = !ost.drm && (isNow || upcoming);
        const canDl = !ost.drm && canTimeshiftProg(ost, p) && (isPast || isNow || upcoming);
        const recAfterOn = !!(reminders[remKey(targetSrc, ost, p)] && reminders[remKey(targetSrc, ost, p)].recordAfter) || (isPast && !!(activeRec[targetSrc] && activeRec[targetSrc].station === ost.name && activeRec[targetSrc].title === p.title));
        d.innerHTML = '<span class="t">' + p.t + '</span><span class="ti">' + highlightMatch(p.title, epgFilter) + (isNow ? '<span class="live">LIVE</span>' : '') + '</span>'
          + (canDl ? '<span class="recBtn' + (recAfterOn ? ' on' : '') + ' recAfter" title="' + (isPast ? 'Stáhnout z archivu' : 'Stáhnout z archivu po skončení pořadu (PC může mezitím spát)') + '">' + DL_SVG + '</span>' : '')
          + (canRecLive ? '<span class="recBtn' + (recOn ? ' on' : '') + ' recLive" title="' + (isNow ? 'Nahrávat hned' : 'Naplánovat nahrávání') + '">⏺</span>' : '')
          + (upcoming ? '<span class="rem' + (marked ? ' on' : '') + '" title="Připomenout a v daný čas přepnout">⏰</span>' : '')
          + (isNow && pctLive !== null ? '<div class="epProg"><div style="width:' + pctLive + '%"></div></div>' : '');
        if (canDl) d.querySelector('.recAfter').onclick = (ev) => {
          ev.stopPropagation();
          if (isPast) toggleRecordFor(ost, p, targetSrc, true);
          else toggleRecordAfter(ost, p, targetSrc);
        };
        if (canRecLive) d.querySelector('.recLive').onclick = (ev) => { ev.stopPropagation(); toggleRecordFor(ost, p, targetSrc, false); };
        if (upcoming) d.querySelector('.rem').onclick = (ev) => { ev.stopPropagation(); toggleReminder(ost, p, targetSrc); };
        d.onclick = (ev) => {
          ev.stopPropagation();
          const targetList = liveChannels[targetSrc] || [];
          const si = targetList.findIndex((x) => chanKeyOf(x) === chanKeyOf(ost));
          if (targetSrc !== curSrc) curSrc = targetSrc;
          if (si >= 0) selIdx = si;
          if (isPast && canTimeshiftProg(ost, p)) {
            renderAll();
            playFromStart(ost, p, 0);
            return;
          }
          if (si >= 0) { renderAll(); applySelection(false); log('stanice → ' + ost.name + ' („' + p.title + '“)'); }
        };
        d.onmouseenter = () => scheduleProgDetail(d, ost, oVis, idx);
        d.onmouseleave = () => hideProgDetail();
        container.appendChild(d);
      });
    };
    for (const m of otherChGroups) appendOtherChannel(e, m.ost, curSrc, m.oVis);
    for (const sg of otherSrcGroups) {
      const grp = document.createElement('div');
      grp.className = 'epSrcGroup';
      const sh = document.createElement('div');
      sh.className = 'epSrcHead';
      sh.innerHTML = '<img class="epSrcLogo" src="' + sg.srcDef.logo + '" alt="' + sg.srcDef.name + '"><span>' + sg.srcDef.name + '</span>';
      grp.appendChild(sh);
      for (const m of sg.srcMatches) appendOtherChannel(grp, m.ost, sg.srcDef.id, m.oVis);
      e.appendChild(grp);
    }
    if (!shown && !otherShown && rows.length) e.innerHTML = '<div class="emptyNote">' + t('noFilterMatch') + '</div>';
    if (sameSt && renderEpg._hasScrolled && prevScroll >= 0) {
      e.scrollTop = prevScroll;
    } else {
      const scrollEl = playEl || nowEl;
      if (scrollEl && !q) {
        const center = () => {
          if (!e.clientHeight) return;
          const target = Math.max(0, scrollEl.offsetTop - e.offsetTop - (e.clientHeight / 2) + (scrollEl.offsetHeight / 2));
          e.scrollTop = target;
          if (target > 0) renderEpg._hasScrolled = true;
        };
        center();
        requestAnimationFrame(center);
      }
    }
  };

  if (!q) {
    cancelEpgSearch();
    const vis = rows.filter((p) => {
      const isPast = p.e2 && p.e2 <= nowMs;
      return !(isPast && !canTimeshiftProg(st, p));
    });
    renderMatches(vis, [], []);
    return;
  }

  const worker = getEpgSearchWorker();
  if (worker && live) {
    const jobId = ++epgSearchJobId;
    const targetSrc = curSrc;
    const targetCk = chanKeyOf(st);
    const neededSrcs = (q.length >= 2 && epgSearchOtherSrc) ? SOURCES.map((s) => s.id) : [targetSrc];
    setEpgSearchProgress(true, 5);
    syncWorkerSources(neededSrcs, worker);
    epgSearchDoneCb = (res) => {
      if (curSrc !== targetSrc || !currentStation() || chanKeyOf(currentStation()) !== targetCk) return;
      const curRows = epgRowsFor(st) || [];
      const vis = [];
      for (const ri of (res.curIdxs || [])) {
        if (curRows[ri]) vis.push(curRows[ri]);
      }
      const otherChGroups = [];
      if (res.otherChMatches && res.otherChMatches.length) {
        const byCk = new Map((liveChannels[targetSrc] || []).map((c) => [chanKeyOf(c), c]));
        for (const m of res.otherChMatches) {
          const ost = byCk.get(m.ck);
          if (!ost) continue;
          const oRows = epgRowsFor(ost) || [];
          const oVis = [];
          for (const ri of m.idxs) { if (oRows[ri]) oVis.push(oRows[ri]); }
          if (oVis.length) otherChGroups.push({ ost, oVis });
        }
      }
      const otherSrcGroups = [];
      if (res.otherSrcMatches) {
        for (const srcDef of SOURCES) {
          if (srcDef.id === targetSrc) continue;
          const list = res.otherSrcMatches[srcDef.id];
          if (!list || !list.length) continue;
          const byCk = new Map((liveChannels[srcDef.id] || []).map((c) => [chanKeyOf(c), c]));
          const srcMatches = [];
          for (const m of list) {
            const ost = byCk.get(m.ck);
            if (!ost) continue;
            const oRows = epgRowsFor(ost) || [];
            const oVis = [];
            for (const ri of m.idxs) { if (oRows[ri]) oVis.push(oRows[ri]); }
            if (oVis.length) srcMatches.push({ ost, oVis });
          }
          if (srcMatches.length) otherSrcGroups.push({ srcDef, srcMatches });
        }
      }
      renderMatches(vis, otherChGroups, otherSrcGroups);
    };
    worker.postMessage({
      type: 'search',
      jobId,
      q,
      curSrc: targetSrc,
      curCk: targetCk,
      otherCh: epgSearchOtherCh,
      otherSrc: epgSearchOtherSrc,
      inDesc: epgSearchDesc,
      nowMs,
      sources: SOURCES.map((s) => s.id),
    });
    return;
  }

  // Fallback kdyz Worker neni dostupny
  const vis = rows.filter((p) => {
    const isPast = p.e2 && p.e2 <= nowMs;
    if (isPast && !canTimeshiftProg(st, p)) return false;
    return epgMatchesQuery(p, q, epgSearchDesc);
  });
  const otherChGroups = [];
  const otherSrcGroups = [];
  if (q.length >= 2) {
    if (epgSearchOtherCh) {
      for (const ost of channels()) {
        if (ost.name === st.name) continue;
        const oRows = epgRowsFor(ost) || [];
        const oVis = oRows.filter((p) => {
          const isPast = p.e2 && p.e2 <= nowMs;
          if (isPast && !canTimeshiftProg(ost, p)) return false;
          return epgMatchesQuery(p, q, epgSearchDesc);
        });
        if (oVis.length) otherChGroups.push({ ost, oVis });
      }
    }
    if (epgSearchOtherSrc) {
      for (const srcDef of SOURCES) {
        if (srcDef.id === curSrc) continue;
        const srcMatches = [];
        for (const ost of (liveChannels[srcDef.id] || [])) {
          const oRows = epgRowsFor(ost) || [];
          const oVis = oRows.filter((p) => {
            const isPast = p.e2 && p.e2 <= nowMs;
            if (isPast && !canTimeshiftProg(ost, p)) return false;
            return epgMatchesQuery(p, q, epgSearchDesc);
          });
          if (oVis.length) srcMatches.push({ ost, oVis });
        }
        if (srcMatches.length) otherSrcGroups.push({ srcDef, srcMatches });
      }
    }
  }
  renderMatches(vis, otherChGroups, otherSrcGroups);
}
document.addEventListener('input', (e) => {
  if (e.target && e.target.id === 'epgFilter') {
    epgFilter = e.target.value; syncEpgFilterClear(); refreshProgDetailHighlight();
    const st = currentStation(); if (st) renderEpg(st);
  }
});
document.addEventListener('change', (e) => {
  if (!e.target) return;
  if (e.target.id === 'epgOptOtherCh') {
    epgSearchOtherCh = !!e.target.checked;
    persistSoon();
    const st = currentStation(); if (st) renderEpg(st);
  } else if (e.target.id === 'epgOptOtherSrc') {
    epgSearchOtherSrc = !!e.target.checked;
    persistSoon();
    const st = currentStation(); if (st) renderEpg(st);
  } else if (e.target.id === 'epgOptDesc') {
    epgSearchDesc = !!e.target.checked;
    persistSoon();
    const st = currentStation(); if (st) renderEpg(st);
  }
});
function renderSources() {
  const w = $('#sources'); w.innerHTML = '';
  SOURCES.forEach((s) => {
    const a = authMeta[s.id];
    const n = (liveChannels[s.id] || []).length;
    const isRec = !!activeRec[s.id];
    const card = document.createElement('div');
    card.className = 'srcCard' + (s.id === curSrc ? ' active' : '') + (isRec ? ' recording' : '');
    const tip = s.name + (a ? (' · ' + (a.profileName || (n ? t('stationsCount', { n }) : t('signedIn')))) : (' · ' + t('notSignedIn'))) + (isRec ? ' · REC' : '');
    card.innerHTML =
      '<div class="srcTop"><div class="srcLogo plain" title="' + tip + '"><img src="' + s.logo + '" alt="' + s.name + '">' + (isRec ? '<span class="recBadge"><span class="recDot"></span>REC</span>' : '') + '</div></div>' +
      (connecting[s.id]
        ? '<div class="srcBtns"><div class="connNote">' + t('connecting') + '</div></div>'
        : '<div class="srcBtns"><button class="btn ' + (a ? '' : 'primary') + '">' + (a ? t('logout') : t('login')) + '</button></div>');
    const mainBtn = card.querySelector('.srcBtns .btn');
    if (mainBtn) mainBtn.onclick = (ev) => {
      ev.stopPropagation();
      if (a) logoutSource(s.id);
      else { if (s.id !== curSrc) switchSource(s.id); openLoginModal(s.id); }
    };
    card.onclick = (ev) => { ev.stopPropagation(); if (s.id !== curSrc) switchSource(s.id); };
    w.appendChild(card);
  });
}
function renderFavs() {
  if (dragging) return;
  hideEpgPop();
  const w = $('#favs');
  const hr = document.getElementById('hrFavs');
  const known = favList().map(stationByFav).filter(Boolean);
  const show = known.length > 0;
  w.style.display = show ? '' : 'none';
  if (hr) hr.style.display = show ? '' : 'none';
  if (!show) return;
  w.innerHTML = '';
  known.forEach((st) => {
    const sel = currentStation() && currentStation().name === st.name;
    const d = document.createElement('div');
    d.className = 'fav' + (st.logo ? ' wide' : '') + (sel ? ' sel' : '');
    d.dataset.key = favKey(st);
    if (st.logo) { d.style.background = 'transparent'; d.innerHTML = '<img src="' + (logoTrimCache[st.logo] || st.logo) + '" alt="' + st.name + '">'; trimLogo(st.logo, d.querySelector('img')); }
    else { d.textContent = st.ini; d.style.background = st.color; }
    d.title = st.name + ' (' + t('favDragTip') + ')';
    d.addEventListener('pointerdown', (e) => favDragStart(e, d, favKey(st)));
    d.onmouseenter = () => scheduleEpgPop(d, st);
    d.onmouseleave = () => hideEpgPopSoon();
    d.onclick = (ev) => {
      if (suppressClick) { suppressClick = false; return; }
      ev.stopPropagation();
      const i = channels().findIndex((s) => s.name === st.name);
      if (i >= 0) {
        if (st.locked) {
          toast(st.noAccess ? t('lockedPackage') : t('lockedParental'), 6000);
          log('zamčená stanice: ' + st.name);
          return;
        }
        if (i === selIdx && video.classList.contains('on')) {
          if (paused) { paused = false; resumeLive(); stage.classList.remove('paused'); persistSoon(); log('▶ přehrávání'); }
          return;
        }
        selIdx = i; applySelection(false); log('oblíbená → ' + st.name);
      }
    };
    w.appendChild(d);
  });
}
const logoTrimCache = {};
const logoTrimPending = {};
function trimLogo(url, imgEl) {
  if (!url || !imgEl || !invoke) return;
  if (logoTrimCache[url]) {
    if (logoTrimCache[url] !== url) imgEl.src = logoTrimCache[url];
    return;
  }
  if (logoTrimPending[url]) {
    logoTrimPending[url].push(imgEl);
    return;
  }
  logoTrimPending[url] = [imgEl];
  invoke('http_get_data_url', { url }).then((dataUrl) => {
    const probe = new Image();
    probe.onload = () => {
      try {
        const w = probe.naturalWidth, h = probe.naturalHeight;
        if (w < 8 || h < 8) { logoTrimCache[url] = url; return; }
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(probe, 0, 0);
        const data = ctx.getImageData(0, 0, w, h).data;
        let minX = w, minY = h, maxX = -1, maxY = -1;
        for (let y = 0; y < h; y++) {
          const row = y * w * 4;
          for (let x = 0; x < w; x++) {
            if (data[row + x * 4 + 3] > 15) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }
        const tw = maxX - minX + 1, th = maxY - minY + 1;
        if (maxX < minX || tw < 6 || th < 6 || (tw >= w * 0.92 && th >= h * 0.92)) {
          logoTrimCache[url] = url;
          return;
        }
        const pad = 2;
        const c2 = document.createElement('canvas');
        c2.width = tw + pad * 2; c2.height = th + pad * 2;
        c2.getContext('2d').drawImage(probe, minX, minY, tw, th, pad, pad, tw, th);
        const out = c2.toDataURL('image/png');
        logoTrimCache[url] = out;
        (logoTrimPending[url] || []).forEach((el) => { if (el.isConnected) el.src = out; });
      } catch {
        logoTrimCache[url] = url;
      } finally {
        delete logoTrimPending[url];
      }
    };
    probe.onerror = () => { logoTrimCache[url] = url; delete logoTrimPending[url]; };
    probe.src = dataUrl;
  }).catch(() => { logoTrimCache[url] = url; delete logoTrimPending[url]; });
}
function stIcon(st) {
  if (st.logo) return '<div class="stIco wide"><img src="' + (logoTrimCache[st.logo] || st.logo) + '" alt="' + st.name + '"></div>';
  return '<div class="stIco" style="background:' + st.color + '">' + st.ini + '</div>';
}
let stationFilter = '';
function renderStations() {
  hideEpgPop();
  const w = $('#stationList'); w.innerHTML = '';
  const list = channels();
  // Log pod zdroji jen kdyz neni co ukazat; pri fungujicim zdroji je skryty.
  const logWrap = document.getElementById('actLogWrap');
  if (logWrap) logWrap.style.display = list.length ? 'none' : '';
  const show = list.length > 0;
  for (const id of ['hrStations', 'stationFilterWrap', 'stationList']) {
    const el = document.getElementById(id);
    if (el) el.style.display = show ? '' : 'none';
  }
  if (!show) return;
  const q = normName(stationFilter);
  const vis = list.map((st, i) => ({ st, i })).filter(({ st }) => !q || normName(st.name).includes(q));
  if (!vis.length) {
    w.innerHTML = '<div class="emptyNote">Nic neodpovídá filtru.</div>';
    return;
  }
  vis.forEach(({ st, i }) => {
    const r = document.createElement('div');
    r.className = 'stRow' + (i === selIdx ? ' sel' : '');
    const fav = favHas(st);
    const li = liveInfo(st);
    const lock = st.locked ? ' <span class="lock" title="uzamčeno">🔒</span>' : '';
    const bar = (li.pct === null || li.pct === undefined) ? '' : '<div class="bar"><div style="width:' + li.pct + '%"></div></div>';
    const prog = !bar ? '' : (li.start
      ? '<div class="progRow"><span>' + li.start + '</span>' + bar + '</div>'
      : bar);
    r.innerHTML = stIcon(st) +
      '<div class="stMid"><div class="stName">' + st.name + lock +
      ' <span class="star ' + (fav ? 'on' : '') + '" title="oblíbená">' + (fav ? '★' : '☆') + '</span></div>' +
      (li.now ? '<div class="stNow">' + li.now + '</div>' : '') + prog + '</div>';
    if (st.logo) trimLogo(st.logo, r.querySelector('.stIco img'));
    r.querySelector('.star').onclick = (ev) => {
      ev.stopPropagation();
      favToggle(st);
      renderFavs(); renderStations();
      log((fav ? '☆ odebráno z oblíbených: ' : '★ oblíbená: ') + st.name);
    };
    r.onmouseenter = () => scheduleEpgPop(r, st);
    r.onmouseleave = () => hideEpgPopSoon();
    r.onclick = () => {
      if (st.locked) {
        toast(st.noAccess ? t('lockedPackage') : t('lockedParental'), 6000);
        log('zamčená stanice: ' + st.name);
        return;
      }
      if (i === selIdx && video.classList.contains('on')) {
        if (paused) { paused = false; resumeLive(); stage.classList.remove('paused'); persistSoon(); log('▶ přehrávání'); }
        return; // jiz hraje, nic neprepinat
      }
      selIdx = i; applySelection(false); log('stanice → ' + st.name + ((liveInfo(st).now || st.now) ? (' („' + (liveInfo(st).now || st.now) + '“)') : ''));
    };
    w.appendChild(r);
  });
}
function renderAll() { renderSources(); renderFavs(); renderReminders(); renderRecPanel(); renderStations(); renderStage(); updatePin(); }
function shortDate(ms) {
  const d = new Date(ms);
  return d.getDate() + '. ' + t('months')[d.getMonth()];
}
// Najit pristi vysilani stejneho poradu na stejnem kanale (nejblizsi den, podobny cas).
function findNextOccurrence(r) {
  const list = liveChannels[r.src] || [];
  const st = list.find((s) => chanKeyOf(s) === r.chan);
  if (!st) return null;
  const rows = epgRowsFor(st) || [];
  const now = Date.now();
  const orig = new Date(r.s);
  const origMins = orig.getHours() * 60 + orig.getMinutes();
  const cands = rows.filter((p) => p.s && p.s > now && (p.title === r.title || normName(p.title) === normName(r.title)));
  if (!cands.length) return null;
  const dayRank = (ms) => { const d = new Date(ms); return d.getFullYear() * 1000 + Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 864e5); };
  cands.sort((a, b) => {
    const da = dayRank(a.s), db = dayRank(b.s);
    if (da !== db) return da - db;
    const ta = new Date(a.s), tb = new Date(b.s);
    return Math.abs(ta.getHours() * 60 + ta.getMinutes() - origMins) - Math.abs(tb.getHours() * 60 + tb.getMinutes() - origMins);
  });
  return cands[0];
}
// Automaticke preplanovani pripnuteho zaznamu (prošlý i právě spuštěný seriál).
// Vrátí true, když se povedlo (starý záznam nahrazen novým).
// Nenalezeno + EPG vůbec není (síť) → zkusit později; nenalezeno + EPG je → chyba na řádku, rozhodne uživatel.
function epgAvailable(r) {
  if (r && r.src) {
    const st = (liveChannels[r.src] || []).find((s) => chanKeyOf(s) === r.chan);
    if (!st) return false;
    const rows = epgRowsFor(st);
    return !!(rows && rows.length > 0);
  }
  return Object.keys(epgBySrc.sltv).length > 0 || Object.keys(epgBySrc.oneplay).length > 0 || Object.keys(epgBySrc.vodafone).length > 0;
}
function planNext(key, r) {
  const target = reminders[key] || r;
  if (!reminders[key] && target) reminders[key] = target;
  const p = findNextOccurrence(target);
  if (!p) {
    if (!epgAvailable(target)) {
      target.retryAt = Date.now() + 60e3; persistSoon();
      log('⏰ EPG nedostupné — zkusím přeplánovat později: ' + target.title);
      return false;
    }
    target.failed = true; target.retryAt = Date.now() + 360e4; persistSoon(); renderReminders();
    const cur = currentStation(); if (cur) renderEpg(cur);
    log('⏰ pokračování nenalezeno: ' + target.title);
    return false;
  }
  delete target.failed; delete target.retryAt; delete target.fired;
  delete reminders[key];
  const nk = target.src + '|' + target.chan + '|' + (p.id || ('s' + p.s));
  reminders[nk] = { src: target.src, chan: target.chan, id: p.id || ('s' + p.s), title: p.title, t: p.t, s: p.s, e2: p.e2, pinned: true, record: !!target.record, recordAfter: !!target.recordAfter, failed: false };
  persistSoon(); renderReminders();
  const cur = currentStation(); if (cur) renderEpg(cur);
  toast('⏰ Přeplánováno na ' + p.t + ' (' + shortDate(p.s) + ')', 8000);
  log('⏰ přeplánováno: ' + p.title + ' ' + p.t + ' ' + shortDate(p.s));
  return true;
}
/* Naplanovane porady: vlastni sekce pod oblibenymi (oddelovac, bez scrollbarhu, roste s poctem).
   Klik prepne stanici (hlasite, primá akce), krizek pripominku zrusi. */
function renderReminders() {
  const w = document.getElementById('remList'), hr = document.getElementById('hrRem');
  if (!w) return;
  const dlJobs = Object.values(activeRec).filter((r) => r && r.archiveDl);
  const keys = Object.keys(reminders).sort((a, b) => (reminders[a].s || 0) - (reminders[b].s || 0));
  const show = keys.length > 0 || dlJobs.length > 0;
  w.style.display = show ? '' : 'none';
  if (hr) hr.style.display = show ? '' : 'none';
  if (!show) return;
  w.innerHTML = '';
  dlJobs.forEach((r) => {
    const d = document.createElement('div');
    d.className = 'remRow';
    d.style.background = r.converting ? 'rgba(37,99,235,.16)' : 'rgba(225,29,72,.12)';
    if (r.converting) {
      let cTxt = '';
      if (r.convEtaSec != null) {
        const rem = Math.max(0, Math.round(r.convEtaSec));
        const eta = rem >= 60 ? (Math.floor(rem / 60) + ' min ' + (rem % 60) + ' s') : (rem + ' s');
        cTxt = t('convMp4') + ' ' + (r.convPct || 0) + '% · ' + t('remEta') + eta;
      } else {
        const cSec = Math.max(0, Math.floor((Date.now() - (r.convStartedAt || Date.now())) / 1000));
        cTxt = t('convMp4') + ' (' + formatElapsed(cSec) + ')';
      }
      d.innerHTML = '<span class="t" style="color:#60a5fa">🎞</span><span class="ti">' + r.title + '<small>' + r.station + ' · ' + cTxt + '</small></span>';
    } else {
      let etaTxt = '';
      const actSec = r.activeSec || r.elapsedSec || 0;
      if (r.reconnecting) {
        etaTxt = ' · <span style="color:#fbbf24">' + t('waitingNet') + '</span>';
      } else if (r.segsDone > 0 && r.segsTotal > r.segsDone && actSec > 0) {
        const rem = Math.max(1, Math.round((actSec / r.segsDone) * (r.segsTotal - r.segsDone)));
        etaTxt = ' · ' + t('remEta') + (rem >= 60 ? (Math.floor(rem / 60) + ' min ' + (rem % 60) + ' s') : (rem + ' s'));
      }
      d.innerHTML = '<span class="t" style="color:#fb7185">' + DL_SVG + '</span><span class="ti">' + r.title + '<small>' + r.station + ' · ' + formatBytes(r.bytes) + etaTxt + '</small></span>'
        + '<span class="rx" title="Zastavit stahování">⏹</span>';
      d.querySelector('.rx').onclick = (ev) => { ev.stopPropagation(); openStopRecModal(r.src, false); };
    }
    w.appendChild(d);
  });
  const todayStr = new Date().toDateString();
  keys.forEach((k) => {
    const r = reminders[k];
    const old = r.e2 && r.e2 <= Date.now();
    const stName = (() => {
      for (const src of ['sltv', 'oneplay', 'vodafone']) {
        const f = (liveChannels[src] || []).find((s) => chanKeyOf(s) === r.chan);
        if (f) return f.name;
      }
      return r.title;
    })();
    const dateHtml = (r.s && new Date(r.s).toDateString() !== todayStr) ? '<small>' + shortDate(r.s) + '</small>' : '';
    const d = document.createElement('div');
    d.className = 'remRow' + (old ? ' old' : '');
    if (r.failed) d.className += ' failed';
    const stObj = (liveChannels[r.src] || []).find((s) => chanKeyOf(s) === r.chan) || null;
    const canRec = !(stObj && stObj.drm);
    const canDl = canRec && stObj && canTimeshiftProg(stObj, { id: r.id, canTimeshift: true });
    d.innerHTML = '<span class="t">' + (r.t || '') + dateHtml + '</span><span class="ti">' + r.title + '<small>' + stName + '</small></span>'
      + (r.failed ? '<span class="rr" title="Zkusit naplánovat znovu ručně">↻</span>' : '')
      + (canDl ? '<span class="recBtn' + (r.recordAfter ? ' on' : '') + ' recAfter" title="' + (r.recordAfter ? 'Zrušit stažení z archivu po skončení' : 'Stáhnout z archivu po skončení pořadu') + '">' + DL_SVG + '</span>' : '')
      + (canRec ? '<span class="recBtn' + (r.record ? ' on' : '') + ' recLive" title="' + (r.record ? 'Zrušit nahrávání' : 'Přidat nahrávání') + '">⏺</span>' : '')
      + '<span class="rp' + (r.pinned ? ' on' : '') + '" title="Připnout automatické plánování">📌</span>'
      + '<span class="rx" title="Zrušit připomínku">×</span>';
    if (canDl) d.querySelector('.recAfter').onclick = (ev) => {
      ev.stopPropagation();
      r.recordAfter = !r.recordAfter;
      persistSoon(); renderAll();
      log(r.recordAfter ? 'stažení z archivu zapnuto: ' + r.title : 'stažení z archivu vypnuto: ' + r.title);
    };
    if (canRec) d.querySelector('.recLive').onclick = (ev) => {
      ev.stopPropagation();
      if (!stObj) return;
      toggleRecordFor(stObj, { t: r.t, s: r.s, e2: r.e2, title: r.title }, r.src);
    };
    if (r.failed) d.querySelector('.rr').onclick = (ev) => {
      ev.stopPropagation();
      if (!planNext(k, r)) toast('Podobný pořad v programu není.', 6000);
    };
    d.querySelector('.rp').onclick = (ev) => {
      ev.stopPropagation();
      r.pinned = !r.pinned;
      delete r.retryAt;
      persistSoon(); renderReminders();
      log(r.pinned ? '📌 automatické plánování zapnuto: ' + r.title : '📌 automatické plánování vypnuto: ' + r.title);
    };
    // Klik na radek nic neprepina — jen krizek a spendlik.
    d.querySelector('.rx').onclick = (ev) => {
      ev.stopPropagation();
      delete reminders[k]; persistSoon(); renderReminders();
      const st = currentStation(); if (st) renderEpg(st);
      log('⏰ připomínka zrušena: ' + r.title);
    };
    w.appendChild(d);
  });
}
// Bez beziciho kanalu je prave menu vzdy vysunute.
function updatePin() {
  if (!currentStation()) {
    document.body.classList.add('rightOpen');
    document.body.classList.remove('leftOpen');
  }
}
async function reloadQuiet() {
  // Tichy cely reload (nova hls instance = novy odhad rychlosti): kdyz je kvalita
  // otravena po spanku/vypadku. Ticho, aby watchdog pri mrtve siti nespamoval.
  const st = currentStation();
  if (!st || paused) return;
  try {
    if (st.opId || st.vfId) st.streamUrl = null; // URL po vypadku expirovana → dohledat znovu v applySelection
    else await fetchStreamUrl(st); // sltv manifesty expiruji: cerstve URL z playlistu
    await applySelection(true);
  } catch {}
}
/* QUIET JE DEFAULT: automaticke prehrani (boot, probuzeni, pripominka, watchdog) nesmi nikdy
   volat renderIdle ani toast — jinak by shodilo priznak 'on' a uz by to nikdo nezkusil znovu.
   Hlasite (false) jen po prime akci uzivatele (klik/klavesa/login). */
async function applySelection(quiet = true) {
  const gen = ++playGen;
  const prevName = selBySrc[curSrc];
  paused = false;
  inTimeshift = false;
  timeshiftProg = null;
  document.body.classList.remove('inTimeshift');
  const st = currentStation();
  if (st) selBySrc[curSrc] = st.name;
  renderFavs(); renderStations(); renderStage();
  if (!st) { wantPlay = false; renderIdle(); persistSoon(); return; }
  if (st.locked) {
    toast(st.noAccess ? 'Stanice není ve vašem balíčku.' : 'Stanice je uzamčena (rodičovský zámek).', 6000);
    log('zamčená stanice: ' + st.name);
    return;
  }
  if (st.opId && (!st.streamUrl || (Date.now() - (st._urlAt || 0) > 15 * 60000))) {
    try {
      const tok = await oneplayToken();
      const m = await oneplayPlayUrl(tok, st.opId);
      const url = m.hls || m.dash || m.dashDrm;
      if (!url) throw new Error('Žádný přehratelný stream (možná DRM).');
      st.streamUrl = url;
      st._urlAt = Date.now();
      if (m.thumbTemplate) st.thumbTemplate = m.thumbTemplate;
      if (m.dashDrm && !m.hls) st.drm = m.drm;
      persistCache();
      renderStations(); renderStage();
    } catch (e) {
      const msg = String(e?.message || e);
      if (/bal[ií][cč]k|tarif|p[rř]edplat|access|opravn|oprávn|forbidden|403/i.test(msg)) {
        st.locked = true; st.noAccess = true; persistCache();
      }
      if (prevName && prevName !== st.name) {
        const pi = channels().findIndex((s) => s.name === prevName);
        if (pi >= 0) { selIdx = pi; selBySrc[curSrc] = prevName; }
      }
      renderFavs(); renderStations(); renderStage();
      if (!quiet) toast(t('streamLoadErr') + msg);
      log('oneplay play: ' + msg);
      return;
    }
  }
  if (st.vfId && (!st.streamUrl || (Date.now() - (st._urlAt || 0) > 15 * 60000))) {
    try {
      const m = await vtvPlayUrl(st);
      if (!m || !m.url) throw new Error('Žádný přehratelný stream.');
      st.streamUrl = m.url;
      st._urlAt = Date.now();
      st._vtvPlay = m;
      st.drm = m.clearContent ? null : { ssm: true, token: m.drmToken || '' };
      persistCache();
      renderStations(); renderStage();
      // Na pozadi doplnit vice dnu EPG pro vybranou stanici (4d archiv + program).
      vtvLoadChannelEpg(st).then((n) => { if (n > 0) renderStage(); }).catch(() => {});
    } catch (e) {
      const msg = String(e?.message || e);
      if (/entitl|not.?subscrib|bal[ií][cč]k|forbidden|403|3032/i.test(msg)) {
        st.locked = true; st.noAccess = true; persistCache();
      }
      if (prevName && prevName !== st.name) {
        const pi = channels().findIndex((s) => s.name === prevName);
        if (pi >= 0) { selIdx = pi; selBySrc[curSrc] = prevName; }
      }
      renderFavs(); renderStations(); renderStage();
      if (!quiet) toast(t('streamLoadErr') + msg);
      log('vodafone play: ' + msg);
      return;
    }
  }
  if (gen !== playGen) return;
  wantPlay = true;
  playStation(st, quiet); persistSoon();
}
function switchSource(id) {
  const old = currentStation();
  if (old) selBySrc[curSrc] = old.name;
  curSrc = id; paused = false;
  const want = selBySrc[id];
  const wi = want ? channels().findIndex((s) => s.name === want) : -1;
  selIdx = wi >= 0 ? wi : 0;
  stationFilter = '';
  const fi = $('#stationFilter'); if (fi) fi.value = '';
  syncFilterClear();
  renderAll();
  // Pres applySelection: umi i zamcene stanice a lazy Oneplay URL (playStation by bez URL jen sumel).
  const st = currentStation();
  if (st) applySelection(false); else { wantPlay = false; renderIdle(); }
  persistSoon();
}
async function logoutSource(id) {
  authMeta[id] = null;
  liveChannels[id] = [];
  // Jen klice daneho zdroje (ostatni zdroje zustavaji).
  if (id === 'sltv') { epgBySrc.sltv = {}; invalidateEpgSearch('sltv'); }
  if (id === 'oneplay') { epgBySrc.oneplay = {}; invalidateEpgSearch('oneplay'); }
  if (id === 'vodafone') { epgBySrc.vodafone = {}; vtvResetSession(); invalidateEpgSearch('vodafone'); }
  if (id === curSrc) { selIdx = 0; wantPlay = false; renderIdle(); }
  try { await vaultClear(id + '.'); } catch (e) { log('trezor: ' + e); }
  persistSoon(); persistCache();
  await storeSet('authMeta', authMeta);
  renderAll();
  log('odhlášeno (' + srcOf(id).name + ')');
}

// klik vs dvojklik vs tazeni oknem: stisk + pohyb = presun okna (Rust),
// stisk + pusteni bez pohybu = klik (pauza / dvojklik maximalizace).
let clickTimer = null;
let dragCand = null, draggingWin = false, suppressStageClick = false;
function stageClick() {
  if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; toggleMax(); }
  else clickTimer = setTimeout(() => { clickTimer = null; togglePause(); }, 260);
}
stage.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  dragCand = { x: e.clientX, y: e.clientY };
  draggingWin = false;
});
stage.addEventListener('mousemove', (e) => {
  if (!dragCand || draggingWin || !invoke) return;
  if (Math.hypot(e.clientX - dragCand.x, e.clientY - dragCand.y) > 6) {
    draggingWin = true;
    document.body.style.cursor = 'grabbing';
    invoke('win_start_drag').catch(() => {}).finally(() => { document.body.style.cursor = ''; });
  }
});
stage.addEventListener('mouseup', () => {
  document.body.style.cursor = '';
  if (draggingWin) { suppressStageClick = true; }
  dragCand = null; draggingWin = false;
});
stage.addEventListener('click', () => {
  if (suppressStageClick) { suppressStageClick = false; return; }
  stageClick();
});
async function fetchStreamUrl(st) {
  // Dohleda cerstve stream URL bez prehrani (priprava obrazu v pauze, retry).
  // Vrati url nebo null. Pro oba zdroje stejne.
  if (!st) return null;
  try {
    if (st.opId) {
      const t = await vaultGet('oneplay.token');
      if (!t) return null;
      const m = await oneplayPlayUrl(t, st.opId);
      const url = m.hls || m.dash || m.dashDrm;
      if (url) { st.streamUrl = url; if (m.dashDrm && !m.hls) st.drm = m.drm; return url; }
      return null;
    }
    if (st.vfId) {
      const m = await vtvPlayUrl(st);
      if (m && m.url) {
        st.streamUrl = m.url;
        st._urlAt = Date.now();
        st._vtvPlay = m;
        st.drm = m.clearContent ? null : { ssm: true, token: m.drmToken || '' };
        return m.url;
      }
      return null;
    }
    if (st.eid && authMeta.sltv && !authMeta.sltv.manual) {
      const fresh = await sltvLoadPlaylist().catch(() => []);
      const f = fresh.find((s) => s.eid === st.eid);
      if (f && f.streamUrl) { st.streamUrl = f.streamUrl; return f.streamUrl; }
    }
  } catch (e) { log('URL se nepodařilo dohledat: ' + (e?.message || e)); }
  return st.streamUrl || null;
}
async function resumeLive() {
  // Bez zdroje (pauza z bootu bez URL) nejde seeknout — dohledat a plne prehrat.
  if (!video.src && currentStation()) {
    await fetchStreamUrl(currentStation());
    try { await applySelection(false); } catch {}
    return;
  }
  // Zive vysilani: po odpauzovani skocit rovnou na zivou hranu — neprehravat nacachovane,
  // protoze kdyz cache dojde, stejne to skoci na aktualni stream.
  try {
    if (hls && hls.liveSyncPosition != null) video.currentTime = hls.liveSyncPosition;
    else if (dashPlayer && typeof dashPlayer.duration === 'function') {
      const d = dashPlayer.duration();
      if (Number.isFinite(d) && d > 0) dashPlayer.seek(Math.max(0, d - 2));
    } else if (video.seekable && video.seekable.length) {
      video.currentTime = video.seekable.end(video.seekable.length - 1);
    }
  } catch {}
  return video.play().catch(() => {});
}
let livePausedAtMs = 0, livePausedProg = null;
function togglePause() {
  if (isLiveRec(curSrc)) return;
  if (!currentStation() && !video.classList.contains('on')) return;
  paused = !paused;
  if (video.classList.contains('on')) {
    if (paused) {
      wantPlay = false;
      video.pause();
      if (!inTimeshift) {
        const st = currentStation();
        const nowMs = Date.now();
        const rows = st ? (epgRowsFor(st) || []) : [];
        const p = rows.find((x) => x.s && x.e2 && x.s <= nowMs && nowMs <= x.e2) || null;
        if (st && p && canTimeshiftProg(st, p)) {
          livePausedAtMs = nowMs;
          livePausedProg = p;
        } else {
          livePausedAtMs = 0;
          livePausedProg = null;
        }
      }
    } else if (inTimeshift) {
      video.play().catch(() => {});
    } else if (livePausedAtMs && livePausedProg && currentStation() && canTimeshiftProg(currentStation(), livePausedProg)) {
      const st = currentStation(), p = livePausedProg;
      const seekSec = Math.max(0, Math.round((livePausedAtMs - p.s) / 1000));
      livePausedAtMs = 0; livePausedProg = null;
      stage.classList.remove('paused');
      persistSoon();
      log('▶ pokračuji ze záznamu (od místa pauzy)');
      playFromStart(st, p, seekSec);
      return;
    } else {
      livePausedAtMs = 0; livePausedProg = null;
      resumeLive();
    }
  }
  stage.classList.toggle('paused', paused && video.classList.contains('on'));
  if (currentStation()) renderBottomBar(currentStation());
  persistSoon();
  log(paused ? '⏸ pauza' : '▶ přehrávání');
}
async function toggleMax() {
  try {
    if (!invoke) return;
    const maxed = await invoke('win_maximize_toggle');
    log(maxed ? '⛶ maximalizováno' : '⛶ okno');
  } catch (e) { log('maximalizace selhala: ' + (e?.message || e)); }
}

// panely se vysouvaji priblizenim mysi k okraji (zadna madla)
let hideT = null;
/* Detail pořadu: hover nad pořadem v levém menu → plovoucí okno VPRAVO od menu (nic nepřekrývá),
   celé v obrazovce bez scrollbarů, myš se dovnitř nedostane (pointer-events:none v CSS). */
let progDetailT = null;
function scheduleProgDetail(row, st, vis, idx) {
  hideProgDetail();
  progDetailT = setTimeout(() => showProgDetail(row, st, vis, idx), 300);
}
let progDetailRaw = null;
function refreshProgDetailHighlight() {
  const pop = document.getElementById('progDetail');
  if (!pop || !pop.classList.contains('on') || !progDetailRaw) return;
  document.getElementById('pdTitle').innerHTML = highlightMatch(progDetailRaw.title, epgFilter);
  document.getElementById('pdDesc').innerHTML = highlightMatch(progDetailRaw.desc, epgFilter);
}
function hideProgDetail() {
  clearTimeout(progDetailT); progDetailT = null; progDetailRaw = null;
  document.getElementById('progDetail').classList.remove('on');
}
function showProgDetail(row, st, vis, idx) {
  const p = vis[idx]; if (!p) return;
  const nowMs = Date.now();
  const isNow = p.s ? (p.s <= nowMs && nowMs <= p.e2) : false;
  const pct = p.s && p.e2 > p.s ? Math.max(0, Math.min(100, Math.round(((nowMs - p.s) / (p.e2 - p.s)) * 100))) : null;
  const img = p.img || st.logo || null;
  const imgEl = document.getElementById('pdImg');
  if (img) { imgEl.src = img; imgEl.style.display = ''; } else { imgEl.removeAttribute('src'); imgEl.style.display = 'none'; }
  const descTxt = p.desc || t('noDesc');
  progDetailRaw = { title: p.title || '', desc: descTxt };
  document.getElementById('pdTitle').innerHTML = highlightMatch(progDetailRaw.title, epgFilter);
  const srcName = (SOURCES.find((s) => s.id === curSrc) || {}).name || curSrc;
  document.getElementById('pdMeta').textContent = st.name + ' · ' + srcName;
  document.getElementById('pdTime').innerHTML = p.t + (p.e ? ' – ' + p.e : '') + (isNow ? '<span class="live">ŽIVĚ</span>' : '');
  const bar = document.getElementById('pdBar');
  if (isNow && pct !== null) { bar.style.display = ''; document.getElementById('pdBarFill').style.width = pct + '%'; }
  else bar.style.display = 'none';
  document.getElementById('pdDesc').innerHTML = highlightMatch(progDetailRaw.desc, epgFilter);
  const pop = document.getElementById('progDetail');
  pop.classList.add('on');
  const panelW = document.getElementById('panelL').offsetWidth || 310;
  pop.style.left = (panelW + 12) + 'px';
  const r = row.getBoundingClientRect();
  const ph = pop.offsetHeight || 300;
  pop.style.top = Math.max(8, Math.min(r.top - 30, window.innerHeight - ph - 8)) + 'px';
}
function scheduleClose() {
  hideProgDetail();
  if (!currentStation() && document.body.classList.contains('rightOpen') && !document.body.classList.contains('leftOpen')) return; // pripnute vpravo
  clearTimeout(hideT);
  hideT = setTimeout(() => {
    if (!currentStation()) { document.body.classList.remove('leftOpen'); return; }
    document.body.classList.remove('rightOpen', 'leftOpen');
  }, 350);
}
let lastMX = -1; // posledni znama poloha mysi (pro rozhodnuti po startu)
let bottomHideT = null, topHideT = null;
function scheduleBottomClose() {
  if (bottomHideT) return;
  bottomHideT = setTimeout(() => { bottomHideT = null; document.body.classList.remove('bottomOpen'); }, 350);
}
function cancelBottomClose() {
  if (bottomHideT) { clearTimeout(bottomHideT); bottomHideT = null; }
}
function scheduleTopClose() {
  if (topHideT) return;
  topHideT = setTimeout(() => { topHideT = null; document.body.classList.remove('topOpen'); }, 350);
}
function cancelTopClose() {
  if (topHideT) { clearTimeout(topHideT); topHideT = null; }
}
document.addEventListener('mousemove', (e) => {
  lastMX = e.clientX;
  if (e.clientX >= window.innerWidth - 24) { clearTimeout(hideT); document.body.classList.add('rightOpen'); }
  // Levy panel jen kdyz je pro stanici program a na zdroji nebezi zive nahravani.
  else if (e.clientX <= 24 && !isLiveRec(curSrc) && currentStation() && epgRowsFor(currentStation()).length) {
    clearTimeout(hideT);
    const wasOpen = document.body.classList.contains('leftOpen');
    document.body.classList.add('leftOpen');
    const st = currentStation();
    if (!wasOpen && st && renderEpg._openedFor !== st.name) {
      renderEpg._openedFor = st.name;
      const epgEl = document.getElementById('epg');
      const curEl = epgEl && epgEl.querySelector('.ep.now');
      if (epgEl && curEl) {
        epgEl.scrollTop = Math.max(0, curEl.offsetTop - epgEl.offsetTop - (epgEl.clientHeight / 2) + (curEl.offsetHeight / 2));
      }
    }
  }
  // Horni lista s obrazovymi filtry.
  if (e.clientY <= 24 && e.clientX > 60 && e.clientX < window.innerWidth - 60) {
    cancelTopClose(); document.body.classList.add('topOpen');
  } else if (document.body.classList.contains('topOpen')) {
    const pt = document.getElementById('panelT');
    const h = pt ? pt.offsetHeight : 150;
    if (e.clientY <= h + 8) cancelTopClose();
    else scheduleTopClose();
  }
  // Dolni lista s informacemi o bezicim poradu: drzi se otevrena v cele sve vysce bez ohledu na osu X.
  const st = currentStation();
  if (st) {
    if (e.clientY >= window.innerHeight - 24) {
      cancelBottomClose(); updateBottomClock(); renderBottomBar(st);
      document.body.classList.add('bottomOpen');
    } else if (document.body.classList.contains('bottomOpen')) {
      const pb = document.getElementById('panelB'), tab = document.getElementById('nbClockTab');
      const h = (pb ? pb.offsetHeight : 130) + (tab ? tab.offsetHeight : 28);
      if (e.clientY >= window.innerHeight - h) cancelBottomClose();
      else scheduleBottomClose();
    }
  }
});
document.addEventListener('mouseleave', () => {
  cancelBottomClose(); cancelTopClose();
  document.body.classList.remove('bottomOpen', 'topOpen');
});

// ---------- Obrazove filtry + WebGL2 GPU shader (AMD CAS + Bicubic upscaling) ----------
(function initVideoFilters() {
  const glCanvas = document.getElementById('glCanvas');
  const vigOv = document.getElementById('fltVigOv'), noiseOv = document.getElementById('fltNoiseOv'), grainOv = document.getElementById('fltGrainOv');
  if (grainOv) {
    const gc = document.createElement('canvas'); gc.width = 128; gc.height = 128;
    const gctx = gc.getContext('2d'), gimg = gctx.createImageData(128, 128), gd = gimg.data;
    for (let i = 0; i < gd.length; i += 4) { const v = (Math.random() * 255) | 0; gd[i] = v; gd[i + 1] = v; gd[i + 2] = v; gd[i + 3] = 255; }
    gctx.putImageData(gimg, 0, 0);
    grainOv.style.backgroundImage = 'url(' + gc.toDataURL('image/png') + ')';
    grainOv.style.backgroundSize = '128px 128px';
  }
  const DEF = { bright: 100, cont: 100, sat: 100, warm: 0, tone: 0, noise: 0, grain: 0, vig: 0, cas: 0, up: 0, auto: 0, bypass: false, profile: '' };
  let flt = { ...DEF };
  try { const s = JSON.parse(localStorage.getItem('tv_video_flt') || 'null'); if (s) flt = { ...DEF, ...s }; } catch {}
  const BUILTIN = {
    standardEnhanced: { key: 'presetStandardEnhanced', bright: 105, cont: 95, sat: 95, warm: 0, tone: 15, noise: 2, grain: 5, vig: 0, cas: 2, up: 1, auto: 1 },
    cinema: { key: 'presetCinema', bright: 95, cont: 115, sat: 92, warm: 8, tone: 25, noise: 8, grain: 0, vig: 35, cas: 0, up: 0, auto: 0 },
    vivid: { key: 'presetVivid', bright: 105, cont: 118, sat: 128, warm: 0, tone: 35, noise: 0, grain: 0, vig: 0, cas: 1, up: 0, auto: 0 },
    night: { key: 'presetNight', bright: 82, cont: 96, sat: 88, warm: 24, tone: 10, noise: 0, grain: 0, vig: 20, cas: 0, up: 0, auto: 0 },
  };
  const FLT_KEYS = ['bright', 'cont', 'sat', 'warm', 'tone', 'noise', 'grain', 'vig', 'cas', 'up', 'auto'];
  let profiles = {};
  try { const sp = JSON.parse(localStorage.getItem('tv_flt_profiles') || 'null'); if (sp && typeof sp === 'object') profiles = sp; } catch {}
  function matchesFlt(a, b) {
    return FLT_KEYS.every((k) => (a[k] ?? DEF[k]) === (b[k] ?? DEF[k]));
  }
  function resolveActiveProfile() {
    if (typeof flt.profile === 'string' && flt.profile) {
      if (flt.profile.startsWith('builtin:') && BUILTIN[flt.profile.slice(8)]) return flt.profile;
      if (flt.profile.startsWith('custom:') && profiles[flt.profile.slice(7)]) return flt.profile;
    }
    for (const n of Object.keys(profiles).sort()) {
      if (matchesFlt(flt, profiles[n])) return 'custom:' + n;
    }
    for (const [k, v] of Object.entries(BUILTIN)) {
      if (matchesFlt(flt, v)) return 'builtin:' + k;
    }
    return '';
  }
  function saveProfiles() {
    try { localStorage.setItem('tv_flt_profiles', JSON.stringify(profiles)); } catch {}
    storeSet('videoFltProfiles', profiles).catch(() => {});
  }
  function renderProfiles(selVal) {
    const sel = document.getElementById('ptProfSel'), del = document.getElementById('ptProfDel');
    if (!sel) return;
    const prev = selVal !== undefined ? selVal : (sel.value || resolveActiveProfile());
    sel.innerHTML = '<option value="">' + t('profSelect') + '</option>';
    const g1 = document.createElement('optgroup'); g1.label = t('profBuiltIn');
    Object.entries(BUILTIN).forEach(([k, v]) => {
      const o = document.createElement('option'); o.value = 'builtin:' + k; o.textContent = t(v.key); g1.appendChild(o);
    });
    sel.appendChild(g1);
    const customNames = Object.keys(profiles).sort();
    if (customNames.length) {
      const g2 = document.createElement('optgroup'); g2.label = t('profCustom');
      customNames.forEach((n) => {
        const o = document.createElement('option'); o.value = 'custom:' + n; o.textContent = n; g2.appendChild(o);
      });
      sel.appendChild(g2);
    }
    sel.value = prev || '';
    if (del) del.disabled = !sel.value.startsWith('custom:');
  }
  window.__renderFltProfiles = () => renderProfiles();
  let gl = null, prog = null, tex = null, uTexSize = null, uCas = null, uUp = null, rafId = 0, glFailed = false;
  function initGl() {
    if (gl || glFailed || !glCanvas) return !!gl;
    gl = glCanvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, preserveDrawingBuffer: false });
    if (!gl) { glFailed = true; return false; }
    const vsSrc = `#version 300 es
      const vec2 p[4] = vec2[](vec2(-1,-1),vec2(1,-1),vec2(-1,1),vec2(1,1));
      out vec2 vUv;
      void main(){ vec2 q = p[gl_VertexID]; vUv = vec2(q.x*0.5+0.5, 0.5-q.y*0.5); gl_Position = vec4(q,0,1); }`;
    const fsSrc = `#version 300 es
      precision highp float;
      uniform sampler2D uTex;
      uniform vec2 uTexSize;
      uniform float uCas;
      uniform int uUp;
      in vec2 vUv;
      out vec4 oCol;
      vec4 wCubic(float v){
        vec4 n = vec4(1.0,2.0,3.0,4.0) - v;
        vec4 s = n*n*n;
        float x = s.x; float y = s.y - 4.0*s.x; float z = s.z - 4.0*s.y + 6.0*s.x; float w = 6.0 - x - y - z;
        return vec4(x,y,z,w)*(1.0/6.0);
      }
      vec3 sampleUp(vec2 uv){
        if(uUp==0) return texture(uTex, uv).rgb;
        vec2 inv = 1.0 / uTexSize;
        vec2 tc = uv * uTexSize - 0.5;
        vec2 f = fract(tc); tc -= f;
        vec4 xc = wCubic(f.x), yc = wCubic(f.y);
        vec4 c = tc.xxyy + vec2(-0.5,1.5).xyxy;
        vec4 s = vec4(xc.xz+xc.yw, yc.xz+yc.yw);
        vec4 o = c + vec4(xc.yw, yc.yw)/s; o *= inv.xxyy;
        vec3 s0 = texture(uTex, o.xz).rgb, s1 = texture(uTex, o.yz).rgb;
        vec3 s2 = texture(uTex, o.xw).rgb, s3 = texture(uTex, o.yw).rgb;
        float sx = s.x/(s.x+s.y), sy = s.z/(s.z+s.w);
        return mix(mix(s3,s2,sx), mix(s1,s0,sx), sy);
      }
      void main(){
        vec3 c = sampleUp(vUv);
        if(uCas > 0.01){
          vec2 px = 1.0 / uTexSize;
          vec3 n = texture(uTex, vUv + vec2(0.0,-px.y)).rgb;
          vec3 s = texture(uTex, vUv + vec2(0.0, px.y)).rgb;
          vec3 w = texture(uTex, vUv + vec2(-px.x,0.0)).rgb;
          vec3 e = texture(uTex, vUv + vec2( px.x,0.0)).rgb;
          vec3 mn = min(c, min(min(n,s), min(w,e)));
          vec3 mx = max(c, max(max(n,s), max(w,e)));
          vec3 amp = clamp(min(mn, 1.0 - mx) / max(mx, vec3(0.001)), 0.0, 1.0);
          amp = sqrt(amp);
          vec3 wt = amp * (-uCas * 0.2);
          c = clamp((c + (n+s+w+e)*wt) / (1.0 + 4.0*wt), 0.0, 1.0);
        }
        oCol = vec4(c, 1.0);
      }`;
    const mk = (t, src) => { const sh = gl.createShader(t); gl.shaderSource(sh, src); gl.compileShader(sh); return sh; };
    prog = gl.createProgram();
    gl.attachShader(prog, mk(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { glFailed = true; gl = null; return false; }
    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    uTexSize = gl.getUniformLocation(prog, 'uTexSize');
    uCas = gl.getUniformLocation(prog, 'uCas');
    uUp = gl.getUniformLocation(prog, 'uUp');
    return true;
  }
  function drawFrame() {
    rafId = 0;
    const needGl = !flt.bypass && (flt.cas > 0 || flt.up > 0) && video.classList.contains('on') && !(currentStation() && currentStation().drm);
    if (!needGl) { if (glCanvas) glCanvas.classList.remove('on'); return; }
    if (!initGl() || gl.isContextLost()) { glCanvas.classList.remove('on'); return; }
    if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
      const dpr = window.devicePixelRatio || 1;
      const cw = Math.max(1, Math.round(stage.clientWidth * dpr));
      const ch = Math.max(1, Math.round(stage.clientHeight * dpr));
      const va = video.videoWidth / video.videoHeight, ca = cw / ch;
      const dw = va > ca ? cw : Math.round(ch * va);
      const dh = va > ca ? Math.round(cw / va) : ch;
      if (glCanvas.width !== dw || glCanvas.height !== dh) { glCanvas.width = dw; glCanvas.height = dh; }
      try {
        gl.viewport(0, 0, dw, dh);
        gl.useProgram(prog);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
        gl.uniform2f(uTexSize, video.videoWidth, video.videoHeight);
        gl.uniform1f(uCas, flt.cas === 2 ? 0.9 : (flt.cas === 1 ? 0.45 : 0.0));
        gl.uniform1i(uUp, flt.up ? 1 : 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        glCanvas.classList.add('on');
      } catch {
        glCanvas.classList.remove('on');
        return;
      }
    }
    if (video.paused || video.ended || document.hidden) return;
    if (video.requestVideoFrameCallback) rafId = video.requestVideoFrameCallback(drawFrame);
    else rafId = requestAnimationFrame(drawFrame);
  }
  function kickGl() {
    const needGl = !flt.bypass && (flt.cas > 0 || flt.up > 0) && video.classList.contains('on') && !(currentStation() && currentStation().drm);
    if (!needGl) { if (glCanvas) glCanvas.classList.remove('on'); return; }
    if (!rafId) drawFrame();
  }
  let autoB = 1.0, autoC = 1.0;
  const autoCan = document.createElement('canvas'); autoCan.width = 32; autoCan.height = 18;
  const autoCtx = autoCan.getContext('2d', { willReadFrequently: true });
  function applyCssFilter() {
    if (flt.bypass) {
      video.style.filter = '';
      if (glCanvas) glCanvas.style.filter = '';
      if (vigOv) vigOv.style.opacity = '0';
      if (noiseOv) noiseOv.style.opacity = '0';
      if (grainOv) grainOv.style.opacity = '0';
      return;
    }
    const toneBoost = 1 + (flt.tone / 100) * 0.25;
    const b = (flt.bright / 100) * (flt.auto ? autoB : 1.0);
    const c = (flt.cont / 100) * toneBoost * (flt.auto ? autoC : 1.0);
    const css = (Math.abs(b - 1) < 0.005 && Math.abs(c - 1) < 0.005 && flt.sat === 100 && flt.warm === 0)
      ? ''
      : ('brightness(' + b.toFixed(3) + ') contrast(' + c.toFixed(3) + ') saturate(' + (flt.sat / 100) + ')' + (flt.warm > 0 ? (' sepia(' + (flt.warm / 100) + ')') : ''));
    video.style.filter = css;
    if (glCanvas) glCanvas.style.filter = css;
    if (vigOv) vigOv.style.opacity = (flt.vig / 100).toFixed(2);
    if (noiseOv) noiseOv.style.opacity = (flt.noise / 100).toFixed(2);
    if (grainOv) grainOv.style.opacity = (flt.grain / 100).toFixed(2);
  }
  setInterval(() => {
    if (grainOv && !flt.bypass && flt.grain > 0 && !document.hidden && video.classList.contains('on') && !video.paused && !video.ended) {
      grainOv.style.backgroundPosition = ((Math.random() * 128) | 0) + 'px ' + ((Math.random() * 128) | 0) + 'px';
    }
  }, 50);
  setInterval(() => {
    if (flt.bypass || !flt.auto || !video.classList.contains('on') || video.paused || video.readyState < 2 || (currentStation() && currentStation().drm)) return;
    try {
      autoCtx.drawImage(video, 0, 0, 32, 18);
      const d = autoCtx.getImageData(0, 0, 32, 18).data;
      let sum = 0, sumSq = 0;
      const n = 32 * 18;
      for (let i = 0; i < d.length; i += 4) {
        const y = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
        sum += y; sumSq += y * y;
      }
      const mean = sum / n;
      const std = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
      // Cilovy stredni jas ~0.46, plynuly prechod bez blikani.
      const tgtB = Math.max(0.88, Math.min(1.22, 1.0 + (0.46 - mean) * 0.45));
      const tgtC = Math.max(0.95, Math.min(1.24, 1.0 + (0.24 - std) * 0.7));
      autoB += (tgtB - autoB) * 0.15;
      autoC += (tgtC - autoC) * 0.15;
      applyCssFilter();
    } catch {}
  }, 250);
  function saveFlt() {
    try { localStorage.setItem('tv_video_flt', JSON.stringify(flt)); } catch {}
    storeSet('videoFlt', flt).catch(() => {});
  }
  function applyFlt(persist = true) {
    if (!flt.auto) { autoB = 1.0; autoC = 1.0; }
    applyCssFilter();
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.value = v; const ve = document.getElementById(id + 'V'); if (ve) ve.textContent = v + ' %'; };
    set('fltBright', flt.bright); set('fltCont', flt.cont); set('fltSat', flt.sat); set('fltWarm', flt.warm);
    set('fltTone', flt.tone); set('fltNoise', flt.noise); set('fltGrain', flt.grain); set('fltVig', flt.vig);
    document.querySelectorAll('[data-cas]').forEach((b) => b.classList.toggle('on', +b.dataset.cas === flt.cas));
    document.querySelectorAll('[data-up]').forEach((b) => b.classList.toggle('on', +b.dataset.up === flt.up));
    document.querySelectorAll('[data-auto]').forEach((b) => b.classList.toggle('on', +b.dataset.auto === flt.auto));
    const eye = document.getElementById('ptBypass'), pt = document.getElementById('panelT');
    if (eye) { eye.classList.toggle('on', !flt.bypass); eye.classList.toggle('off', !!flt.bypass); }
    if (pt) pt.classList.toggle('bypassed', !!flt.bypass);
    if (persist) saveFlt();
    kickGl();
  }
  [['fltBright', 'bright'], ['fltCont', 'cont'], ['fltSat', 'sat'], ['fltWarm', 'warm'], ['fltTone', 'tone'], ['fltNoise', 'noise'], ['fltGrain', 'grain'], ['fltVig', 'vig']].forEach(([id, k]) => {
    const el = document.getElementById(id);
    if (el) el.oninput = (e) => {
      flt[k] = +e.target.value;
      applyFlt(true);
    };
  });
  const rst = document.getElementById('ptReset');
  if (rst) rst.onclick = () => {
    flt = { ...DEF };
    const sel = document.getElementById('ptProfSel'), del = document.getElementById('ptProfDel');
    if (sel) sel.value = ''; if (del) del.disabled = true;
    applyFlt(true); log('✨ obrazové filtry resetovány');
  };
  const profSel = document.getElementById('ptProfSel'), profSave = document.getElementById('ptProfSave'), profDel = document.getElementById('ptProfDel');
  const saveModal = document.getElementById('profSaveModal'), saveInp = document.getElementById('profSaveInput');
  const delModal = document.getElementById('profDelModal'), delText = document.getElementById('profDelText');
  let pendingDelName = '';
  const closeSaveModal = () => { if (saveModal) saveModal.classList.remove('on'); };
  const closeDelModal = () => { if (delModal) delModal.classList.remove('on'); pendingDelName = ''; };
  const commitSave = () => {
    const n = (saveInp && saveInp.value || '').trim();
    if (!n) { if (saveInp) saveInp.focus(); return; }
    const { bypass, profile, ...snap } = flt;
    profiles[n] = snap; saveProfiles();
    flt.profile = 'custom:' + n; saveFlt();
    renderProfiles(flt.profile);
    closeSaveModal();
    log('💾 uložen profil filtrů: ' + n);
  };
  if (profSel) profSel.onchange = () => {
    const v = profSel.value;
    if (profDel) profDel.disabled = !v.startsWith('custom:');
    if (v.startsWith('builtin:')) {
      const p = BUILTIN[v.slice(8)];
      if (p) { Object.assign(flt, DEF, p, { bypass: false, profile: v }); applyFlt(true); log('✨ předvolba: ' + t(p.key)); }
    } else if (v.startsWith('custom:')) {
      const n = v.slice(7);
      if (profiles[n]) { Object.assign(flt, DEF, profiles[n], { bypass: false, profile: v }); applyFlt(true); log('✨ načten profil: ' + n); }
    } else {
      flt.profile = ''; saveFlt();
    }
  };
  if (profSave) profSave.onclick = () => {
    if (!saveModal) return;
    const dl = document.getElementById('profSaveList');
    if (dl) {
      dl.innerHTML = '';
      Object.keys(profiles).sort().forEach((n) => {
        const o = document.createElement('option'); o.value = n; dl.appendChild(o);
      });
    }
    saveInp.value = (profSel && profSel.value.startsWith('custom:')) ? profSel.value.slice(7) : '';
    saveModal.classList.add('on');
    setTimeout(() => { saveInp.focus(); saveInp.select(); }, 30);
  };
  document.getElementById('btnProfSaveCancel').onclick = closeSaveModal;
  document.getElementById('btnProfSaveOk').onclick = commitSave;
  if (saveInp) saveInp.onkeydown = (e) => { if (e.key === 'Enter') commitSave(); else if (e.key === 'Escape') closeSaveModal(); };
  if (profDel) profDel.onclick = () => {
    const v = (profSel && profSel.value) || ''; if (!v.startsWith('custom:')) return;
    pendingDelName = v.slice(7);
    if (delText) delText.textContent = t('profDelText', { name: pendingDelName });
    if (delModal) delModal.classList.add('on');
  };
  document.getElementById('btnProfDelCancel').onclick = closeDelModal;
  document.getElementById('btnProfDelOk').onclick = () => {
    if (!pendingDelName || !profiles[pendingDelName]) { closeDelModal(); return; }
    const n = pendingDelName;
    delete profiles[n]; saveProfiles();
    if (flt.profile === 'custom:' + n) { flt.profile = ''; saveFlt(); }
    renderProfiles('');
    closeDelModal();
    log('🗑 smazán profil filtrů: ' + n);
  };
  renderProfiles(resolveActiveProfile());
  storeGet('videoFltProfiles').then((v) => {
    if (v && typeof v === 'object') { profiles = v; renderProfiles(resolveActiveProfile()); }
  }).catch(() => {});
  document.querySelectorAll('[data-cas]').forEach((btn) => {
    btn.onclick = () => { flt.cas = +btn.dataset.cas; applyFlt(true); log('✨ doostření (CAS): ' + btn.textContent); };
  });
  document.querySelectorAll('[data-up]').forEach((btn) => {
    btn.onclick = () => { flt.up = +btn.dataset.up; applyFlt(true); log('✨ GPU upscaling shader: ' + btn.textContent); };
  });
  document.querySelectorAll('[data-auto]').forEach((btn) => {
    btn.onclick = () => { flt.auto = +btn.dataset.auto; applyFlt(true); log('✨ auto jas/kontrast: ' + btn.textContent); };
  });
  const eyeBtn = document.getElementById('ptBypass');
  if (eyeBtn) eyeBtn.onclick = () => {
    flt.bypass = !flt.bypass;
    applyFlt(true);
    log(flt.bypass ? '👁 obrazové filtry dočasně vypnuty' : '👁 obrazové filtry zapnuty');
  };
  if (glCanvas) {
    glCanvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      glCanvas.classList.remove('on');
      gl = null; prog = null; tex = null; rafId = 0;
      log('⚠ WebGL kontext ztracen (reset GPU ovladače) — přepínám na přímé video');
    });
    glCanvas.addEventListener('webglcontextrestored', () => {
      gl = null; prog = null; tex = null; glFailed = false;
      log('✨ WebGL kontext obnoven');
      kickGl();
    });
  }
  video.addEventListener('play', kickGl);
  video.addEventListener('playing', () => { paused = false; stage.classList.remove('paused'); });
  video.addEventListener('loadeddata', kickGl);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) kickGl(); });
  applyFlt(false);
  storeGet('videoFlt').then((v) => {
    if (v && typeof v === 'object') { flt = { ...DEF, ...v }; applyFlt(false); renderProfiles(resolveActiveProfile()); }
  }).catch(() => {});
})();

// ---------- Jazyk aplikace (EN default / CS) ----------
(function initLangUi() {
  const sel = document.getElementById('langSel');
  if (sel) {
    sel.value = getLang();
    sel.onchange = () => {
      setLang(sel.value);
      storeSet('lang', sel.value).catch(() => {});
      if (window.__renderFltProfiles) window.__renderFltProfiles();
      renderAll();
      if (currentStation()) renderBottomBar(currentStation());
      log('🌐 language: ' + sel.value.toUpperCase());
    };
  }
  applyI18n();
  storeGet('lang').then((v) => {
    if ((v === 'en' || v === 'cs') && v !== getLang()) {
      setLang(v);
      renderAll();
      if (currentStation()) renderBottomBar(currentStation());
    }
  }).catch(() => {});
})();
(function () {
  const savedR = +(localStorage.getItem('tvklient.panelW_R') || 0);
  const savedL = +(localStorage.getItem('tvklient.panelW_L') || 0);
  window.__panelW = { R: savedR, L: savedL };
  function applyW() {
    if (window.__panelW.R > 0) $('#panelR').style.width = Math.max(400, window.__panelW.R) + 'px';
    if (window.__panelW.L > 0) $('#panelL').style.width = window.__panelW.L + 'px';
  }
  applyW();
  storeGet('panelW').then((v) => {
    if (v && (v.R > 0 || v.L > 0)) {
      window.__panelW = v;
      try {
        localStorage.setItem('tvklient.panelW_R', v.R || 0);
        localStorage.setItem('tvklient.panelW_L', v.L || 0);
      } catch {}
      applyW();
    }
  });
  [['resR', 'panelR', 'R'], ['resL', 'panelL', 'L']].forEach(([rid, pid, key]) => {
    const h = document.getElementById(rid), p = document.getElementById(pid);
    if (!h || !p) return;
    h.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation(); h.setPointerCapture(e.pointerId); h.classList.add('drag');
      const move = (ev) => {
        const wpx = pid === 'panelR' ? window.innerWidth - ev.clientX : ev.clientX;
        const minW = pid === 'panelR' ? 400 : 220;
        p.style.width = Math.max(minW, Math.min(620, wpx)) + 'px';
      };
      const up = () => {
        h.classList.remove('drag');
        h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up);
        window.__panelW[key] = parseInt(p.style.width, 10);
        try {
          localStorage.setItem('tvklient.panelW_' + key, window.__panelW[key]);
        } catch {}
        storeSet('panelW', window.__panelW);
      };
      h.addEventListener('pointermove', move); h.addEventListener('pointerup', up);
    });
  });
})();
$('#panelR').addEventListener('mouseleave', scheduleClose);
$('#panelL').addEventListener('mouseleave', scheduleClose);
// Mys rychle opustila okno/monitor: zadne mouseleave panelu neprijde, tak je zavrit rovnou.
function closeAllPanels() {
  clearTimeout(hideT);
  cancelBottomClose();
  if (!currentStation()) { document.body.classList.remove('leftOpen', 'bottomOpen'); }
  else document.body.classList.remove('rightOpen', 'leftOpen', 'bottomOpen');
  hideEpgPop();
}
document.documentElement.addEventListener('mouseleave', closeAllPanels);
window.addEventListener('blur', closeAllPanels);
$('#panelR').addEventListener('mouseenter', () => clearTimeout(hideT));
$('#panelL').addEventListener('mouseenter', () => clearTimeout(hideT));
// Interaktivni filtr stanic (bez diakritiky, okamzite zuzuje seznam) + krizek.
function syncFilterClear() {
  const fi = document.getElementById('stationFilter'), b = document.getElementById('stationFilterClear');
  if (fi && b) b.classList.toggle('on', !!fi.value);
}
document.addEventListener('input', (e) => {
  if (e.target && e.target.id === 'stationFilter') { stationFilter = e.target.value; syncFilterClear(); renderStations(); }
});
document.getElementById('stationFilterClear').onclick = () => {
  const fi = document.getElementById('stationFilter');
  stationFilter = ''; if (fi) { fi.value = ''; fi.focus(); } syncFilterClear(); renderStations();
};
document.getElementById('epgFilterClear').onclick = () => {
  const fi = document.getElementById('epgFilter');
  epgFilter = ''; if (fi) { fi.value = ''; fi.focus(); } syncEpgFilterClear(); refreshProgDetailHighlight();
  const st = currentStation(); if (st) renderEpg(st);
};
// EPG popup: po chvili hoveru seznam dalsich poradu VLEVO od praveho menu.
let epgPopT = null;
function epgRowsOf(st) {
  const nowMs = Date.now();
  const pctOf = (p) => {
    if (p.s && p.e2 > p.s) return Math.max(0, Math.min(100, Math.round(((nowMs - p.s) / (p.e2 - p.s)) * 100)));
    return (p.pct !== undefined && p.pct !== null) ? p.pct : null;
  };
  const isLive = (p) => p.s ? (p.s <= nowMs && nowMs <= p.e2) : !!p.now;
  const live = epgRowsFor(st);
  if (live && live.length) {
    // Od beziciho/nadchazejiciho poradu (ne prvnich 6 dnem — ty uz bezely).
    let from = live.findIndex((p) => (p.s && p.e2 ? p.e2 > nowMs : true));
    if (from < 0) from = 0;
    return live.slice(from, from + 6).map((p) => ({ id: p.id || null, s: p.s || 0, e2: p.e2 || 0, t: p.t, title: p.title, now: isLive(p), pct: pctOf(p) }));
  }
  return (st.epg || []).slice(0, 6).map((p) => ({ id: null, s: 0, e2: 0, t: p.t, title: p.title, now: false, pct: null }));
}
function scheduleEpgPop(row, st) {
  hideEpgPop();
  epgPopT = setTimeout(() => showEpgPop(row, st), 600);
}
let epgPopHideT = null;
function hideEpgPop() {
  clearTimeout(epgPopT); epgPopT = null;
  clearTimeout(epgPopHideT); epgPopHideT = null;
  const pop = document.getElementById('epgPop');
  if (pop) pop.classList.remove('on');
}
// Prechod mysi z radku do popupu: nezavirat hned, pockat (popup je dosazitelny).
function hideEpgPopSoon() {
  clearTimeout(epgPopT); epgPopT = null;
  clearTimeout(epgPopHideT);
  epgPopHideT = setTimeout(() => hideEpgPop(), 350);
}
// Mys je v popupu = porad v pravem menu: panel se nesmi zavrit.
document.getElementById('epgPop').addEventListener('mouseenter', () => { clearTimeout(epgPopHideT); clearTimeout(hideT); });
document.getElementById('epgPop').addEventListener('mouseleave', () => { hideEpgPop(); scheduleClose(); });
function showEpgPop(row, st) {
  const pop = document.getElementById('epgPop');
  const list = document.getElementById('epgPopList');
  if (!pop || !list) return;
  document.getElementById('epgPopHead').textContent = st.name;
  list.innerHTML = '';
  const nowMs = Date.now();
  epgRowsOf(st).forEach((p) => {
    const d = document.createElement('div');
    d.className = 'ep' + (p.now ? ' now' : '');
    const marked = !!reminders[remKey(curSrc, st, p)];
    const recOn = !!(reminders[remKey(curSrc, st, p)] && reminders[remKey(curSrc, st, p)].record) || !!(activeRec[curSrc] && activeRec[curSrc].station === st.name && activeRec[curSrc].title === p.title);
    const isPast = p.e2 && p.e2 <= nowMs;
    const upcoming = p.s && p.s > nowMs;
    const canRec = !st.drm && (!!p.now || upcoming);
    const canDl = !st.drm && canTimeshiftProg(st, p) && (isPast || !!p.now || upcoming);
    const recAfterOn = !!(reminders[remKey(curSrc, st, p)] && reminders[remKey(curSrc, st, p)].recordAfter);
    d.innerHTML = '<span class="t">' + (p.t || '') + '</span><span class="ti">' + p.title + (p.now ? '<span class="live">LIVE</span>' : '') + '</span>'
      + (canDl ? '<span class="recBtn' + (recAfterOn ? ' on' : '') + ' recAfter" title="' + (isPast ? 'Stáhnout z archivu' : 'Stáhnout z archivu po skončení pořadu') + '">' + DL_SVG + '</span>' : '')
      + (canRec ? '<span class="recBtn' + (recOn ? ' on' : '') + ' recLive" title="' + (p.now ? 'Nahrávat hned' : 'Naplánovat nahrávání') + '">⏺</span>' : '')
      + (upcoming ? '<span class="rem' + (marked ? ' on' : '') + '" title="Připomenout a v daný čas přepnout">⏰</span>' : '')
      + (p.now && p.pct !== null ? '<div class="epProg"><div style="width:' + p.pct + '%"></div></div>' : '');
    if (canDl) d.querySelector('.recAfter').onclick = (ev) => {
      ev.stopPropagation();
      if (isPast) toggleRecordFor(st, p, curSrc, true);
      else toggleRecordAfter(st, p);
      ev.currentTarget.classList.toggle('on', !!(reminders[remKey(curSrc, st, p)] && reminders[remKey(curSrc, st, p)].recordAfter));
    };
    if (canRec) d.querySelector('.recLive').onclick = (ev) => {
      ev.stopPropagation();
      toggleRecordFor(st, p);
      ev.target.classList.toggle('on', !!(reminders[remKey(curSrc, st, p)] && reminders[remKey(curSrc, st, p)].record));
    };
    if (upcoming) d.querySelector('.rem').onclick = (ev) => {
      ev.stopPropagation();
      toggleReminder(st, p);
      ev.target.classList.toggle('on', !!reminders[remKey(curSrc, st, p)]);
    };
    list.appendChild(d);
  });
  pop.classList.add('on');
  const panelW = document.getElementById('panelR').offsetWidth || 400;
  pop.style.left = Math.max(8, window.innerWidth - panelW - 10 - 360) + 'px';
  const r = row.getBoundingClientRect();
  const ph = pop.offsetHeight || 220;
  pop.style.top = Math.max(8, Math.min(r.top, window.innerHeight - ph - 8)) + 'px';
}
document.getElementById('stationList').addEventListener('scroll', hideEpgPop, { passive: true });
document.getElementById('epg').addEventListener('scroll', hideProgDetail, { passive: true });

// ---------- oblibene drag & drop ----------
let dragEl = null, dragName = '', dragHole = null, dragSX = 0, dragSY = 0, dragging = false, suppressClick = false, dragFrom = -1;
// Vkládací režim (jako prototyp): tažená ikona se vyndá z toku a díra cestuje na pozici
// vložení. Všechny ikony za dírou se posunou společně, pořadí se nikdy nemění.
function favDragStart(e, d, n) {
  if (e.button !== undefined && e.button > 0) return;
  window.removeEventListener('pointermove', favDragMove);
  window.removeEventListener('pointerup', favDragEnd);
  window.removeEventListener('pointercancel', favDragEnd);
  dragEl = d; dragName = n; dragSX = e.clientX; dragSY = e.clientY; dragging = false;
  dragFrom = favList().indexOf(n);
  window.addEventListener('pointermove', favDragMove);
  window.addEventListener('pointerup', favDragEnd);
  window.addEventListener('pointercancel', favDragEnd);
}
function favDragMove(e) {
  if (!dragEl) return;
  if (!dragging) {
    if (Math.hypot(e.clientX - dragSX, e.clientY - dragSY) < 6) return;
    dragging = true; suppressClick = true;
    const r = dragEl.getBoundingClientRect();
    dragHole = document.createElement('div'); dragHole.className = 'fav-hole';
    dragEl.before(dragHole);
    dragEl.classList.add('ghost');
    dragEl.style.width = r.width + 'px'; dragEl.style.height = r.height + 'px';
    document.body.appendChild(dragEl);
    log('★ tažení: „' + dragName + '“');
  }
  dragEl.style.left = (e.clientX - dragEl.offsetWidth / 2) + 'px';
  dragEl.style.top = (e.clientY - dragEl.offsetHeight / 2) + 'px';
  // Index vložení podle HRAN (ne středů): díra uskakuje ihned, jak kurzor přejede hranu ikony.
  // Měří se na layoutu BEZ díry (jinak by se díra a ikony přetahovaly o pozici a vše kmitalo).
  const w = document.querySelector('#favs');
  dragHole.remove();
  const items = [...w.querySelectorAll('.fav')];
  let idx = items.length;
  for (let k = 0; k < items.length; k++) {
    const r = items[k].getBoundingClientRect();
    const inBand = e.clientY >= r.top - 2 && e.clientY <= r.bottom + 2;
    if (!inBand) { if (e.clientY < r.top) { idx = k; break; } continue; }
    if (e.clientX < r.right - 2) { idx = k; break; }
  }
  w.insertBefore(dragHole, idx < items.length ? items[idx] : null);
}
function favDragEnd() {
  window.removeEventListener('pointermove', favDragMove);
  window.removeEventListener('pointerup', favDragEnd);
  window.removeEventListener('pointercancel', favDragEnd);
  if (!dragEl) return;
  if (dragging && dragHole) {
    dragEl.classList.remove('ghost');
    dragEl.style.width = ''; dragEl.style.height = ''; dragEl.style.left = ''; dragEl.style.top = '';
    dragHole.replaceWith(dragEl);
    favBySrc[curSrc] = [...new Set([...$('#favs').querySelectorAll('.fav')].map((el) => el.dataset.key))];
    const to = favList().indexOf(dragName);
    const nm = (stationByFav(dragName) || {}).name || dragName;
    renderFavs(); renderStations(); persistSoon();
    log('★ přesun „' + nm + '“: pozice ' + (dragFrom + 1) + ' → ' + (to + 1));
  }
  dragEl = null; dragHole = null; dragging = false;
}

// ---------- SledovaniTV API (pres Rust backend, bez CORS) ----------
function sltvPlaylistPath() {
  return '/api/playlist?format=m3u8&quality=40&capabilities=h264';
}
async function sltvLoadPlaylist() {
  const txt = await sltvGet('/api/playlist?format=m3u8&quality=40&capabilities=h264');
  return parseSltvPlaylist(JSON.parse(txt));
}
let sltvEpgP = null;
async function sltvFetchEpgDay(d) {
  const p = (n) => String(n).padStart(2, '0');
  const base = new Date(Date.now() + d * 1440 * 60000);
  const tstr = base.getFullYear() + '-' + p(base.getMonth() + 1) + '-' + p(base.getDate()) + ' ' + p(base.getHours()) + ':' + p(base.getMinutes()) + ':00';
  return JSON.parse(await sltvGet('/api/epg?detail=description&duration=1439&time=' + encodeURIComponent(tstr)));
}
function sltvMergeEpg(out, seen, j) {
  if (!j || !j.channels) return;
  for (const [ch, events] of Object.entries(j.channels)) {
    if (!out[ch]) { out[ch] = []; seen[ch] = new Set(); }
    for (const ev of events || []) {
      const key = ev.eventId !== undefined ? String(ev.eventId) : (ev.startTime + '|' + ev.title);
      if (seen[ch].has(key)) continue;
      seen[ch].add(key);
      const s = new Date(String(ev.startTime || '').replace(' ', 'T')).getTime();
      const e2 = new Date(String(ev.endTime || '').replace(' ', 'T')).getTime();
      if (!s || !e2) continue;
      out[ch].push({
        id: ev.eventId !== undefined ? String(ev.eventId) : null,
        canTimeshift: (ev.availability === 'timeshift') || (Number(ev.timeshift) > 0),
        t: String(ev.startTime || '').slice(11, 16), e: String(ev.endTime || '').slice(11, 16),
        title: ev.title || '?', desc: (ev.description || '').slice(0, 500), img: null,
        s, e2, day: new Date(s).toDateString(),
      });
    }
    out[ch].sort((a, b) => a.s - b.s);
  }
}
function sltvLoadEpgBg() {
  if (sltvEpgP) return sltvEpgP;
  sltvEpgP = (async () => {
    const out = {};
    const seen = {};
    const runBatch = async (days) => {
      const res = await Promise.allSettled(days.map((d) => sltvFetchEpgDay(d)));
      res.forEach((r, idx) => {
        if (r.status === 'fulfilled') sltvMergeEpg(out, seen, r.value);
        else log('EPG den ' + days[idx] + ' selhal: ' + (r.reason?.message || r.reason));
      });
      if (Object.keys(out).length) {
        epgBySrc.sltv = out;
        invalidateEpgSearch('sltv');
        persistCache();
        renderAll();
      }
    };
    try {
      // 1. Dnesek ihned, 2. budoucnost (+1..+3), 3. historie (-1..-7) paralelne po davkach.
      await runBatch([0]);
      scanEpgWatches('sltv');
      await runBatch([1, 2, 3]);
      scanEpgWatches('sltv');
      await runBatch([-1, -2, -3]);
      await runBatch([-4, -5, -6, -7]);
      log('EPG načteno pro ' + Object.keys(epgBySrc.sltv).length + ' kanálů');
      logEpgCoverage();
    } catch (e) {
      log('EPG: ' + (e?.message || e));
    } finally {
      sltvEpgP = null;
    }
    return out;
  })();
  return sltvEpgP;
}
async function sltvLoadEpg() {
  return sltvLoadEpgBg();
}
function dayLabel(ms) {
  const d = new Date(ms), now = new Date();
  const tag = d.toDateString() === now.toDateString() ? (' · ' + t('today'))
    : new Date(now.getTime() + 86400000).toDateString() === d.toDateString() ? (' · ' + t('tomorrow')) : '';
  return t('daysUpper')[d.getDay()] + ' ' + d.getDate() + '. ' + (d.getMonth() + 1) + '.' + tag;
}

// ---------- trezor (sifrovane uloziste pres Rust backend) ----------
// DOCASNE DIAGNOSTICKE: zapis se overuje zpetnym ctenim. Pokud Rust trezor
// neulozi, pouzije se localStorage + hlasite varovani (odblokuje test,
// prozradi kde je chyba). Po oprave trezoru smazat.
let vaultBroken = false;
async function vaultSet(k, v) {
  // returns 'rust' | 'bridge' | 'verify:<co se vratilo>'
  const fail = (reason) => {
    vaultBroken = true;
    try { localStorage.setItem('tvklient.vault.' + k, v); } catch {}
    if (!vaultSet._warned) {
      vaultSet._warned = true;
      log('trezor nedostupný: ' + reason);
      toast('Trezor (šifrované úložiště) je nedostupný: ' + reason + '. Dočasně ukládám nešifrovaně, jen pro test.', 12000);
    }
    return reason;
  };
  if (!invoke) return fail('v aplikaci chybí TAURI bridge');
  try {
    await invoke('vault_set', { key: k, value: v });
  } catch (e) { return fail('rust chyba při zápisu: ' + (e?.message || e)); }
  let back;
  try { back = await invoke('vault_get', { key: k }); }
  catch (e) { return fail('rust chyba při čtení: ' + (e?.message || e)); }
  if (back === v) { vaultSet._ok = true; return 'rust'; }
  return fail('zápis se neprojevil (přečteno: ' + JSON.stringify(back) + ')');
}
async function vaultGet(k) {
  if (invoke) {
    try {
      const v = await invoke('vault_get', { key: k });
      if (v !== null && v !== undefined) return v;
    } catch (e) { log('trezor: cteni selhalo ' + k + ': ' + (e?.message || e)); }
  }
  try { return localStorage.getItem('tvklient.vault.' + k); }
  catch { return null; }
}
async function vaultClear(prefix) {
  if (invoke) { try { await invoke('vault_clear', { prefix }); } catch (e) { log('trezor: mazani selhalo: ' + (e?.message || e)); } }
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith('tvklient.vault.' + prefix)) localStorage.removeItem(k);
    }
  } catch {}
}

// ---------- SledovaniTV (plne seamless pres backend, zadne profily) ----------
function apiErr(j, fallback) {
  if (!j || typeof j !== 'object') return fallback;
  return j.error || j.message || (j.status !== undefined ? 'kód ' + JSON.stringify(j.status) : fallback);
}
async function sltvPair(username, password) {
  let serial = await storeGet('sltv.serial');
  if (!serial) { serial = 'tvclient-' + Math.random().toString(36).slice(2, 12); await storeSet('sltv.serial', serial); }
  const url = 'https://sledovanitv.cz/api/create-pairing?username=' + encodeURIComponent(username)
    + '&password=' + encodeURIComponent(password) + '&type=xbmc&product=tvclient&serial=' + encodeURIComponent(serial);
  let j;
  try { j = JSON.parse(await apiGet(url)); }
  catch (e) { throw new Error('Spárování: síťová chyba — ' + (e?.message || e)); }
  if (!j.deviceId || j.deviceId === 'null') throw new Error('Spárování odmítnuto (' + apiErr(j, 'zkontroluj jméno a heslo') + ').');
  await vaultSet('sltv.deviceId', String(j.deviceId));
  await vaultSet('sltv.devicePass', String(j.password));
  const check = await vaultGet('sltv.deviceId');
  if (check !== String(j.deviceId)) throw new Error('Trezor neukládá (zápis se neprojevil: ' + JSON.stringify(check) + ').');
  return sltvRefresh();
}
async function sltvRefresh() {
  const deviceId = await vaultGet('sltv.deviceId');
  const devPass = await vaultGet('sltv.devicePass');
  if (!deviceId || !devPass) throw new Error('Chybí spárování zařízení — nejdřív dokonči přihlášení (pairing). Trezor je prázdný.');
  const url = 'https://sledovanitv.cz/api/device-login?deviceId=' + encodeURIComponent(deviceId)
    + '&password=' + encodeURIComponent(devPass) + '&unit=default';
  let j;
  try { j = JSON.parse(await apiGet(url)); }
  catch (e) { throw new Error('Device-login: síťová chyba — ' + (e?.message || e)); }
  if (!j.PHPSESSID || j.PHPSESSID === 'null') throw new Error('Device-login odmítnut (' + apiErr(j, 'neznámá chyba') + ').');
  await vaultSet('sltv.token', j.PHPSESSID);
  await vaultSet('sltv.token_ts', String(Date.now()));
  const check = await vaultGet('sltv.token');
  if (!check) throw new Error('Trezor neukládá token (zápis se neprojevil).');
  return j.PHPSESSID;
}
async function sltvToken() {
  // Zamerne BEZ casove expirace: ulozene sezeni se pouziva, dokud funguje.
  // Nove sezeni (device-login) vznika jen pri prokazanem vyprseni.
  const tok = await vaultGet('sltv.token');
  if (tok) return tok;
  return sltvRefreshOnce();
}
let sltvRefreshP = null;
function sltvRefreshOnce() {
  if (!sltvRefreshP) sltvRefreshP = sltvRefresh().finally(() => { sltvRefreshP = null; });
  return sltvRefreshP;
}
function isNotLogged(e, txt) {
  if (txt) { try { if (JSON.parse(txt).status === 0) return true; } catch {} }
  return /not.?logged|401|unauthor|sess/i.test(String((e && (e.message || e)) || ''));
}
// Volani SledovaniTV API s ulozenym tokenem; pri expiraci JEDEN refresh a retry.
async function sltvGet(path) {
  const q = path.includes('?') ? '&' : '?';
  let token = await sltvToken();
  try {
    const t = await apiGet('https://sledovanitv.cz' + path + q + 'PHPSESSID=' + encodeURIComponent(token));
    if (isNotLogged(null, t)) throw new Error('not-logged');
    return t;
  } catch (e) {
    if (String(e && (e.message || e)) === 'not-logged' || isNotLogged(e)) {
      log('sezení vypršelo, obnovuji (jednou)…');
      token = await sltvRefreshOnce();
      return await apiGet('https://sledovanitv.cz' + path + q + 'PHPSESSID=' + encodeURIComponent(token));
    }
    throw e;
  }
}
async function sltvLoadChannels() {
  const list = await sltvLoadPlaylist();
  if (!list.length) throw new Error('Seznam stanic je prázdný.');
  const lockedN = list.filter((s) => s.locked).length;
  log('playlist: ' + list.length + ' stanic (zamčených: ' + lockedN + ')');
  // EPG stahovat asynchronne na pozadi (dnes -> budoucnost -> historie), neblokovat pripojeni zdroje.
  sltvLoadEpgBg();
  return list;
}

// ---------- Oneplay (seamless pres backend WS transport) ----------
let opReloginP = null;
function oneplayReloginOnce() {
  if (!opReloginP) opReloginP = oneplaySilentLogin().finally(() => { opReloginP = null; });
  return opReloginP;
}
async function opCall(api, data, token, retry = true) {
  if (!invoke) throw new Error('Oneplay vyžaduje spuštěnou aplikaci (blokuje CORS).');
  try {
    return await invoke('oneplay_call', { api, data: data || {}, token: token || null });
  } catch (e) {
    const msg = String(e?.message || e);
    if (retry && /session|login|expir|401|unauthor|token|kdo se d.v/i.test(msg)) {
      log('Oneplay sezení neplatné, přihlašuji znovu (jednou)…');
      const ok = await oneplayReloginOnce().catch(() => false);
      if (ok) {
        const t2 = await vaultGet('oneplay.token');
        return await invoke('oneplay_call', { api, data: data || {}, token: t2 });
      }
    }
    throw e;
  }
}
function oneplayBearerOf(data) {
  const step = (data || {}).step || {};
  return step.bearerToken || ((step.user || {}).bearerToken) || null;
}
async function oneplayLoginStep(username, password, accountId, authCode) {
  const cmd = accountId
    ? { schema: 'LoginWithAccountCommand', accountId, authCode }
    : { schema: 'LoginWithCredentialsCommand', email: username, password };
  return opCall('user.login.step', { payload: { command: cmd } }, null);
}
async function oneplayBeginLogin(username, password) {
  const data = await oneplayLoginStep(username, password);
  const token = oneplayBearerOf(data);
  if (token) {
    await vaultSet('oneplay.username', username);
    await vaultSet('oneplay.password', password);
    await vaultSet('oneplay.token', token);
    await vaultSet('oneplay.token_ts', String(Date.now()));
    return { token };
  }
  const step = (data || {}).step || {};
  if (step.schema === 'ShowAccountChooserStep') {
    const accs = [];
    for (const g of step.groups || []) for (const a of g.accounts || []) {
      if (a.extId || a.isActive) accs.push({ id: a.accountId, name: a.name, suffix: a.extId || a.accountProvider || '' });
    }
    if (!accs.length) throw new Error('Oneplay vyžaduje výběr účtu, ale žádný nenabídl.');
    return { accounts: accs, authToken: step.authToken, username, password };
  }
  throw new Error('Oneplay po přihlášení nevrátil token.');
}
async function oneplayProfiles(token) {
  const data = await opCall('user.profiles.display', { payload: { mode: 'change' } }, token);
  const list = (((data || {}).availableProfiles || {}).profiles) || [];
  return list.map((p) => ({ id: p.profile.id, name: p.profile.name, avatar: p.profile.avatarUrl || null }));
}
async function oneplaySelectProfile(token, profileId) {
  const data = await opCall('user.profile.select', { payload: { profileId } }, token);
  const t = (data || {}).bearerToken;
  if (!t) throw new Error('Výběr profilu nevrátil token.');
  return t;
}
async function oneplayChannels(token, profileId) {
  const data = await opCall('epg.channels.display', { payload: { profileId: String(profileId) } }, token);
  const out = [];
  for (const ch of (data || {}).channelList || []) {
    if (ch.upsell === true) continue;
    if (ch.flags && ch.flags.upsell) continue;
    // CDN 'r{sw}x{sh}n' orezava na ctverec — pro siroky box (62x38) zadat siroky rozmer.
    const logo = String(ch.logo || '').replace('{WIDTH}', '320').replace('{HEIGHT}', '196');
    out.push({
      opId: ch.id, name: ch.name, ini: String(ch.name || '?').slice(0, 3).toUpperCase(), color: '#2563eb',
      logo: logo || null, now: '', pct: null, epg: [],
      streamUrl: null, drm: null, order: ch.order || 0,
    });
  }
  out.sort((a, b) => (a.order || 0) - (b.order || 0));
  return out;
}
// Oneplay EPG: epg.display s viewportem (-2 h .. +24 h), klice 'op:' + channelId (stejne id jako seznam).
async function oneplayLoadEpg(token) {
  const p = (n) => String(n).padStart(2, '0');
  const hhmm = (ms) => { const d = new Date(ms); return p(d.getHours()) + ':' + p(d.getMinutes()); };
  const iso = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.000Z'; };
  const nowMs = Date.now();
  const data = await opCall('epg.display', { payload: { criteria: { channelSetId: 'channel_list.1', viewport: { channelRange: { from: 0, to: 200 }, timeRange: { from: iso(nowMs - 7 * 24 * 360e4), to: iso(nowMs + 7 * 24 * 360e4) }, schema: 'EpgViewportAbsolute' } }, requestedOutput: { channelList: 'none', datePicker: false, channelSets: false } } }, token);
  const sch = (data && data.schedule) || [];
  let n = 0;
  for (const c of sch) {
    const rows = [];
    for (const it of c.items || []) {
      const s = new Date(it.startAt).getTime(), e2 = new Date(it.endAt).getTime();
      if (!s || !e2) continue;
      rows.push({
        id: it.id !== undefined && it.id !== null ? String(it.id) : null,
        t: String(it.startAtFormatted || '').slice(0, 5) || hhmm(s), e: hhmm(e2),
        title: it.title || '?', desc: (it.description || '').slice(0, 500),
        img: String(it.image || '').replace('{WIDTH}', '480').replace('{HEIGHT}', '320') || null,
        s, e2, day: new Date(s).toDateString(),
      });
    }
    rows.sort((a, b) => a.s - b.s);
    if (rows.length && c.channelId) { epgBySrc.oneplay[c.channelId] = rows; n++; }
  }
  if (n > 0) invalidateEpgSearch('oneplay');
  return n;
}
let opEpgP = null;
function opEpgFresh() {
  // Cerste = nejnovejsi konec poradu v budoucnosti (viewport je -2 h..+24 h, propadle se musi dotahnout).
  const nowMs = Date.now();
  let best = 0;
  for (const k of Object.keys(epgBySrc.oneplay)) {
    const rows = epgBySrc.oneplay[k];
    if (rows && rows.length && rows[rows.length - 1].e2 > best) best = rows[rows.length - 1].e2;
  }
  return best > nowMs;
}
function oneplayEnsureEpg(force) {
  // Single-flight: stahne, jen kdyz chybi nebo je propadle (nebo force), a jen kdyz je Oneplay prihlasene.
  if (opEpgP) return opEpgP;
  opEpgP = (async () => {
    try {
      if (!(authMeta.oneplay && authMeta.oneplay.logged)) return 0;
      if (!force && opEpgFresh()) return -1;
      const t = await vaultGet('oneplay.token');
      if (!t) return 0;
      const n = await oneplayLoadEpg(t);
      log('Oneplay EPG: program pro ' + n + ' stanic');
      const miss = (liveChannels.oneplay || []).filter((st) => !epgRowsFor(st)).map((st) => st.name);
      if (miss.length) log('Oneplay EPG bez shody: ' + miss.join(', '));
      if (n > 0) scanEpgWatches('oneplay');
      return n;
    } finally { opEpgP = null; }
  })();
  return opEpgP;
}
async function oneplayPlayUrl(token, channelId) {
  const post = {
    payload: { criteria: { schema: 'ContentCriteria', contentId: 'channel.' + channelId }, startMode: 'start' },
    playbackCapabilities: {
      protocols: ['dash', 'hls'], drm: ['widevine', 'fairplay'], altTransfer: 'Unicast',
      subtitle: { formats: ['vtt'], locations: ['InstreamTrackLocation', 'ExternalTrackLocation'] },
      liveSpecificCapabilities: { protocols: ['dash', 'hls'], drm: ['widevine', 'fairplay'], altTransfer: 'Unicast', multipleAudio: false },
    },
  };
  const data = await opCall('content.play', post, token);
  const thumbTemplate = (data && data.media && data.media.images && data.media.images.thumbnailImageTemplate) || null;
  const assets = ((((data || {}).media || {}).stream || {}).assets) || [];
  let hls = null, dash = null, dashDrm = null, drm = null;
  for (const a of assets) {
    if (a.protocol === 'dash' && a.drm && a.drm.length) {
      dashDrm = a.src;
      drm = { token: a.drm[0].drmAuthorization.value, licenceUrl: a.drm[0].licenseAcquisitionURL };
    }
    else if (a.protocol === 'dash' && !dash) dash = a.src;
    else if (a.protocol === 'hls' && !a.drm && !hls) hls = a.src;
  }
  return { hls, dash, dashDrm, drm, thumbTemplate };
}
async function oneplayToken() {
  // Bez casove expirace: ulozene sezeni se zkusi, pri chybe prevezme retry v opCall.
  const tok = await vaultGet('oneplay.token');
  if (tok) return tok;
  const ok = await oneplayReloginOnce().catch(() => false);
  if (!ok) throw new Error('Sezení vypršelo — přihlas se znovu.');
  return await vaultGet('oneplay.token');
}
async function oneplaySilentLogin() {
  const user = await vaultGet('oneplay.username');
  const pass = await vaultGet('oneplay.password');
  if (!user || !pass) return false;
  let r;
  try { r = await oneplayBeginLogin(user, pass); }
  catch (e) { log('Oneplay silent login: ' + (e?.message || e)); return false; }
  if (r.accounts) { log('Oneplay: vyžadován výběr účtu — nutná ruční volba'); return false; }
  const pid = await vaultGet('oneplay.profileId');
  if (!pid) return false;
  let token;
  try { token = await oneplaySelectProfile(r.token, pid); }
  catch (e) { log('Oneplay: uložený profil neplatí — nutná volba'); return false; }
  await vaultSet('oneplay.token', token);
  await vaultSet('oneplay.token_ts', String(Date.now()));
  const pname = (await vaultGet('oneplay.profileName')) || '';
  authMeta.oneplay = { logged: true, profileId: pid, profileName: pname, updatedAt: Date.now() };
  oneplayEnsureEpg().then((n) => { if (n > 0) renderAll(); }).catch(() => {});
  try {
    const list = await oneplayChannels(token, pid);
    if (list.length) { liveChannels.oneplay = list; log('Oneplay: kanály obnoveny (' + list.length + ')'); }
  } catch (e) { log('Oneplay: kanály se nepodařilo obnovit: ' + (e?.message || e)); }
  return true;
}
// Prihlaseni z modalu: login -> (ucty) -> profily -> hotovo.
async function doOneplayLogin(user, pass) {
  // Udaje patri do trezoru hned po stisku Prihlasit, pred samotnym loginem.
  await vaultSet('oneplay.username', user);
  await vaultSet('oneplay.password', pass);
  log('přihlašuji Oneplay…');
  const r = await oneplayBeginLogin(user, pass);
  if (r.accounts) {
    showChoiceStep('Vyber účet', r.accounts.map((a) => ({ id: a.id, name: a.name + (a.suffix ? ' (' + a.suffix + ')' : ''), avatar: null })),
      (acc) => doOneplayAccount(acc.id, r.authToken, user, pass));
    return;
  }
  const profiles = await oneplayProfiles(r.token);
  if (!profiles.length) throw new Error('Na účtu nejsou žádné profily.');
  pendingOneplay = { token: r.token };
  showChoiceStep('Kdo sleduje? (Oneplay)', profiles, pickOneplayProfile);
}
async function doOneplayAccount(accountId, authToken, user, pass) {
  const data = await oneplayLoginStep(user, pass, accountId, authToken);
  const token = oneplayBearerOf(data);
  if (!token) throw new Error('Výběr účtu nevrátil token.');
  await vaultSet('oneplay.username', user);
  await vaultSet('oneplay.password', pass);
  await vaultSet('oneplay.token', token);
  await vaultSet('oneplay.token_ts', String(Date.now()));
  const profiles = await oneplayProfiles(token);
  if (!profiles.length) throw new Error('Na účtu nejsou žádné profily.');
  pendingOneplay = { token };
  showChoiceStep('Kdo sleduje? (Oneplay)', profiles, pickOneplayProfile);
}
async function pickOneplayProfile(p) {
  const t = await oneplaySelectProfile(pendingOneplay.token, p.id);
  await vaultSet('oneplay.token', t);
  await vaultSet('oneplay.token_ts', String(Date.now()));
  await vaultSet('oneplay.profileId', String(p.id));
  await vaultSet('oneplay.profileName', p.name);
  authMeta.oneplay = { logged: true, profileId: String(p.id), profileName: p.name, updatedAt: Date.now() };
  await storeSet('authMeta', authMeta);
  const list = await oneplayChannels(t, p.id);
  liveChannels.oneplay = list;
  try { await oneplayEnsureEpg(true); } catch (e) { log('Oneplay EPG: ' + (e?.message || e)); }
  persistCache();
  closeLoginModal();
  pendingOneplay = null;
  if (curSrc !== 'oneplay') { curSrc = 'oneplay'; selIdx = 0; }
  renderAll();
  applySelection(false);
  log('Oneplay přihlášeno · profil ' + p.name + ' (' + list.length + ' kanálů)');
}

// ---------- Vodafone TV CZ (Kaltura Cloud TV + Nagra DAS + SSM Widevine) ----------
const VTV_SSM_LICENSE_URL = 'https://vtv-ssm.local/license';
let vtvCfg = null, vtvCfgP = null;
let vtvDasLoaded = false, vtvDasSessionId = null;
let vtvSession = null; // { ks, expiry, userId, householdId, deviceId, keyId, alg, cdnTokens }
let vtvReloginP = null;
let vtvEpgP = null;
const vtvChanEpgAt = new Map();
let vtvSsm = null; // { sessionToken, heartbeat, timer, reqBody, assetId, assetType, fileId, programId, licensed }
let vtvXhrHooked = false;

function vtvResetSession() {
  vtvSsmStop().catch(() => {});
  vtvSession = null;
  vtvDasSessionId = null;
  vtvChanEpgAt.clear();
}

function vtvUdid() {
  try {
    let id = localStorage.getItem('tvklient.vtvUdid');
    if (!id) {
      id = (crypto && crypto.randomUUID) ? crypto.randomUUID() : ('vtv-' + Date.now() + '-' + Math.random().toString(16).slice(2));
      localStorage.setItem('tvklient.vtvUdid', id);
    }
    return id;
  } catch {
    return 'vtv-fallback-' + Date.now();
  }
}

async function vtvEnsureConfig() {
  if (vtvCfg) return vtvCfg;
  if (vtvCfgP) return vtvCfgP;
  vtvCfgP = (async () => {
    if (!invoke) throw new Error('Vodafone TV vyžaduje spuštěnou aplikaci (blokuje CORS).');
    let dmsUrl = 'https://3062.dms-vfp2.ott.kaltura.com/';
    try {
      const initXml = await invoke('http_get', { url: 'https://tv.vodafone.cz/init.xml' });
      const m = /<dms_url>\s*([^<\s]+)\s*<\/dms_url>/i.exec(String(initXml || ''));
      if (m && m[1]) dmsUrl = m[1].endsWith('/') ? m[1] : (m[1] + '/');
    } catch {}
    const qs = new URLSearchParams({
      username: 'dms',
      password: 'tvinci',
      appname: VODAFONE_DMS_APP,
      cver: VODAFONE_DMS_CVER,
      udid: vtvUdid(),
      platform: 'Other',
      partnerId: '3062',
    }).toString();
    let dmsRaw = await invoke('http_get', { url: dmsUrl + 'getconfig?' + qs });
    let dmsJson = JSON.parse(dmsRaw);
    if (String(dmsJson?.status || '').toLowerCase() === 'unregistered') {
      await invoke('http_get', { url: dmsUrl + 'register?' + qs });
      dmsRaw = await invoke('http_get', { url: dmsUrl + 'getconfig?' + qs });
      dmsJson = JSON.parse(dmsRaw);
    }
    const cfg = parseDmsConfig(dmsJson);
    const certUrl = cfg.licenseServerUrl.replace(/\/?$/, '/') + cfg.tenantId + '/wvls/contentlicenseservice/v1/certificates';
    const [publicKeyPem, opVaultText, wvCertB64] = await Promise.all([
      invoke('http_get', { url: cfg.publicKeyUrl }),
      invoke('http_get', { url: cfg.opVaultAddress }),
      invoke('vodafone_get_b64', { url: certUrl }).catch(() => null),
    ]);
    cfg.publicKeyPem = publicKeyPem;
    cfg.opVaultText = opVaultText;
    cfg.wvCertB64 = wvCertB64;
    vtvCfg = cfg;
    return cfg;
  })().finally(() => { vtvCfgP = null; });
  return vtvCfgP;
}

async function vtvEnsureDas() {
  const cfg = await vtvEnsureConfig();
  if (!vtvDasLoaded) {
    if (typeof window.init !== 'function' || typeof window.openSession !== 'function') {
      const [joseCode, dasCode] = await Promise.all([
        invoke('http_get', { url: 'https://tv.vodafone.cz/assets/js/das/lib/jose.min.js' }),
        invoke('http_get', { url: 'https://tv.vodafone.cz/assets/js/das/dasWebSDK.js' }),
      ]);
      (0, eval)(joseCode);
      (0, eval)(dasCode);
    }
    vtvDasLoaded = true;
  }
  const initR = await window.init(cfg.opVaultText);
  if (!initR || initR.status !== 'NV_DAS_SUCCESS') {
    throw new Error('Nagra DAS init selhal: ' + (initR?.message || initR?.status || '?'));
  }
  const openR = await window.openSession();
  if (!openR || openR.status !== 'NV_DAS_SUCCESS' || !openR.data) {
    throw new Error('Nagra DAS openSession selhal: ' + (openR?.message || openR?.status || '?'));
  }
  vtvDasSessionId = openR.data;
  const chalR = await window.getChallenge(vtvDasSessionId);
  if (!chalR || chalR.status !== 'NV_DAS_SUCCESS' || !chalR.data) {
    throw new Error('Nagra DAS challenge selhal: ' + (chalR?.message || chalR?.status || '?'));
  }
  return chalR.data;
}

async function vtvSignBody(bodyStr) {
  if (!vtvDasSessionId || !vtvSession || !vtvSession.keyId) {
    throw new Error('Vodafone TV: chybí DAS klíč sezení.');
  }
  const bufStr = window.convertStringtoBuffer(bodyStr).data.toString();
  const sig = await window.sign(vtvDasSessionId, vtvSession.keyId, bufStr);
  if (!sig || sig.status !== 'NV_DAS_SUCCESS' || !sig.data) {
    throw new Error('Vodafone TV: podpis požadavku selhal.');
  }
  const hex = Array.from(sig.data).map((b) => b.toString(16).padStart(2, '0')).join('');
  return vtvSession.alg + ':' + hex;
}

async function vtvBeginLogin(username, password) {
  const cfg = await vtvEnsureConfig();
  const challenge = await vtvEnsureDas();
  const encPass = rsaEncryptPkcs1(cfg.publicKeyPem, password);
  const url = cfg.vtvApiGw + 'authentication/v2/credentials';
  const payload = JSON.stringify({
    username,
    password: encPass,
    deviceBrandId: VODAFONE_BRAND_ID,
  });
  const res = await invoke('vodafone_post', {
    url,
    body: payload,
    headers: { 'vtv-authentication': 'web:' + challenge },
  });
  const parsed = parseVodafoneLoginResponse(res && res.body, res && res.headers, res ? res.status : 0);
  if (parsed.encryptedSessionRight) {
    const imp = await window.importLicense(vtvDasSessionId, parsed.encryptedSessionRight);
    if (!imp || imp.status !== 'NV_DAS_SUCCESS') {
      throw new Error('Nagra DAS importLicense selhal.');
    }
  }
  vtvSession = {
    ks: parsed.ks,
    expiry: parsed.expiry,
    userId: parsed.userId,
    householdId: parsed.householdId,
    deviceId: parsed.deviceId,
    keyId: parsed.keyId,
    alg: parsed.alg,
    cdnTokens: parsed.cdnTokens,
  };
  return vtvSession;
}

function vtvReloginOnce() {
  if (!vtvReloginP) vtvReloginP = vtvSilentLogin(false).finally(() => { vtvReloginP = null; });
  return vtvReloginP;
}

async function vtvEnsureSession() {
  if (vtvSession && vtvSession.ks && (!vtvSession.expiry || vtvSession.expiry > Date.now() + 5 * 60000)) {
    return vtvSession;
  }
  const ok = await vtvReloginOnce().catch(() => false);
  if (!ok || !vtvSession) throw new Error('Vodafone TV: sezení vypršelo — přihlas se znovu.');
  return vtvSession;
}

async function vtvSignedPost(url, bodyObj, allowRetry = true) {
  const cfg = await vtvEnsureConfig();
  const sess = await vtvEnsureSession();
  // Synchronizovat ks i v podrizenych requests[].body (napr. ccursession/v1/start po reloginu).
  const fullBody = {
    ...bodyObj,
    apiVersion: bodyObj.apiVersion || cfg.apiVersion,
    ks: sess.ks,
  };
  if (Array.isArray(fullBody.requests)) {
    fullBody.requests = fullBody.requests.map((req) => {
      if (req && req.body && typeof req.body === 'object' && 'ks' in req.body) {
        return { ...req, body: { ...req.body, ks: sess.ks } };
      }
      return req;
    });
  }
  const bodyStr = JSON.stringify(fullBody);
  const authSig = await vtvSignBody(bodyStr);
  const headers = { 'vtv-authorization': authSig };
  if (sess.deviceId) headers['vtv-id'] = sess.deviceId;
  const res = await invoke('vodafone_post', { url, body: bodyStr, headers });
  const body = res && res.body;
  const errObj = (body && body.result && body.result.error) || (body && body.error) || null;
  const errCode = String((errObj && errObj.code) || '');
  const errMsg = String((errObj && errObj.message) || '');
  // 403 muze byt NotEntitled (nepredplaceny kanal) — neni to vyprsene sezeni!
  const isAuthErr = res?.status === 401
    || /^(1011|1016|500016|500015|apigw-10005|apigw-10006|apigw-10007)$/i.test(errCode)
    || /invalid.*ks|session.*expired/i.test(errMsg);
  if (isAuthErr && allowRetry) {
    log('Vodafone TV sezení neplatné (HTTP ' + (res?.status || '?') + ' ' + errCode + '), přihlašuji znovu…', 'WARN', 'VTV');
    vtvSession = null;
    const ok = await vtvReloginOnce().catch(() => false);
    if (ok && vtvSession) return vtvSignedPost(url, bodyObj, false);
  }
  if ((res && res.status >= 400) || errObj) {
    const rawDetail = errMsg || (typeof body === 'string' ? body.slice(0, 180) : JSON.stringify(body || {}).slice(0, 220)) || ('HTTP ' + (res?.status || '?'));
    const e = new Error(rawDetail + (errCode ? ' [' + errCode + ']' : ''));
    e.httpStatus = res ? res.status : 0;
    e.vtvCode = errCode;
    throw e;
  }
  return body;
}

async function vtvLoadChannels() {
  const cfg = await vtvEnsureConfig();
  const entP = vtvSignedPost(cfg.phoenix + 'entitlement/action/list', {
    filter: {
      objectType: 'KalturaEntitlementFilter',
      entitlementTypeEqual: 'subscription',
      entityReferenceEqual: 'household',
      isExpiredEqual: false,
    },
    pager: { objectType: 'KalturaFilterPager', pageSize: 200, pageIndex: 1 },
  }).then((d) => {
    const set = new Set();
    for (const e of (d?.result?.objects || [])) {
      if (e && e.entitlementId !== undefined && e.entitlementId !== null) set.add(String(e.entitlementId));
    }
    return set;
  }).catch(() => new Set());

  const entitledP = vtvSignedPost(cfg.phoenix + 'asset/action/list', {
    filter: {
      objectType: 'KalturaSearchAssetFilter',
      typeIn: '735',
      kSql: "(and entitled_assets='entitled')",
    },
    pager: { objectType: 'KalturaFilterPager', pageSize: 500, pageIndex: 1 },
  }).then((d) => {
    const set = new Set();
    for (const o of (d?.result?.objects || [])) {
      if (o && o.id !== undefined && o.id !== null) set.add(String(o.id));
    }
    return set;
  }).catch(() => new Set());

  const fetchPage = (pageIndex) => vtvSignedPost(cfg.phoenix + 'asset/action/list', {
    filter: { objectType: 'KalturaSearchAssetFilter', typeIn: '735', orderBy: 'NAME_ASC' },
    pager: { objectType: 'KalturaFilterPager', pageSize: 500, pageIndex },
  });

  const [subSet, entitledSet, page1] = await Promise.all([entP, entitledP, fetchPage(1)]);
  let all = (page1?.result?.objects) || [];
  const total = Number(page1?.result?.totalCount || all.length);
  if (total > all.length && all.length > 0) {
    const page2 = await fetchPage(2).catch(() => null);
    if (page2?.result?.objects) all = all.concat(page2.result.objects);
  }
  const parsed = parseVodafoneChannels(all, subSet.size ? subSet : null, entitledSet.size ? entitledSet : null);
  log('Vodafone TV: kanály ' + parsed.length + ' (předplacených: ' + (entitledSet.size || '?') + ')', 'INFO', 'VTV');
  return parsed;
}

function vtvMergeEpg(grouped) {
  let n = 0;
  for (const [cid, rows] of Object.entries(grouped)) {
    const existing = epgBySrc.vodafone[cid];
    if (existing && existing.length) {
      const byId = new Map();
      for (const r of existing) byId.set(r.id || String(r.s), r);
      for (const r of rows) byId.set(r.id || String(r.s), r);
      epgBySrc.vodafone[cid] = [...byId.values()].sort((a, b) => a.s - b.s);
    } else {
      epgBySrc.vodafone[cid] = rows;
    }
    n++;
  }
  if (n > 0) invalidateEpgSearch('vodafone');
  return n;
}

async function vtvLoadEpg() {
  const cfg = await vtvEnsureConfig();
  const nowSec = Math.floor(Date.now() / 1000);
  // Faze 1 (okamzita): 1 rychly dotaz jen na prave bezici porady → zaplni "Prave bezi" pro vsechny stanice hned.
  try {
    const liveRes = await vtvSignedPost(cfg.phoenix + 'asset/action/list', {
      filter: {
        objectType: 'KalturaSearchAssetFilter',
        kSql: `(and start_date<='${nowSec}' end_date>'${nowSec}')`,
        orderBy: 'START_DATE_ASC',
        typeIn: '0',
      },
      pager: { objectType: 'KalturaFilterPager', pageSize: 500, pageIndex: 1 },
    });
    const liveObjs = (liveRes && liveRes.result && liveRes.result.objects) || [];
    if (liveObjs.length) {
      vtvMergeEpg(parseVodafoneEpgObjects(liveObjs));
      renderAll();
    }
  } catch {}

  // Faze 2 (paralelni): zbytek dne (-2 h .. +24 h) naraz v 6 paralelnich strankach.
  const t0 = nowSec - 2 * 3600;
  const t1 = nowSec + 24 * 3600;
  const kSql = `(and start_date>='${t0}' start_date<'${t1}')`;
  const pages = await Promise.all([1, 2, 3, 4, 5, 6].map((pageIndex) =>
    vtvSignedPost(cfg.phoenix + 'asset/action/list', {
      filter: {
        objectType: 'KalturaSearchAssetFilter',
        kSql,
        orderBy: 'START_DATE_ASC',
        typeIn: '0',
      },
      pager: { objectType: 'KalturaFilterPager', pageSize: 500, pageIndex },
    }).then((d) => (d && d.result && d.result.objects) || []).catch(() => []),
  ));
  const all = pages.flat();
  const n = vtvMergeEpg(parseVodafoneEpgObjects(all));
  return n;
}

const vtvChanEpgPending = new Set();
async function vtvLoadChannelEpg(st) {
  if (!st || !st.vfEpgId || !vtvSession) return 0;
  const cid = String(st.vfEpgId);
  const last = vtvChanEpgAt.get(cid) || 0;
  if (Date.now() - last < 15 * 60000 || vtvChanEpgPending.has(cid)) return 0;
  vtvChanEpgPending.add(cid);
  try {
    const cfg = await vtvEnsureConfig();
    const nowSec = Math.floor(Date.now() / 1000);
    const t0 = nowSec - 3 * 24 * 3600;
    const t1 = nowSec + 4 * 24 * 3600;
    const d = await vtvSignedPost(cfg.phoenix + 'asset/action/list', {
      filter: {
        objectType: 'KalturaSearchAssetFilter',
        kSql: `(and start_date>='${t0}' start_date<'${t1}' epg_channel_id:'${cid}')`,
        orderBy: 'START_DATE_ASC',
        typeIn: '0',
      },
      pager: { objectType: 'KalturaFilterPager', pageSize: 500, pageIndex: 1 },
    });
    const objs = (d && d.result && d.result.objects) || [];
    const grouped = parseVodafoneEpgObjects(objs);
    if (grouped[cid] && grouped[cid].length) {
      epgBySrc.vodafone[cid] = grouped[cid];
      invalidateEpgSearch('vodafone');
      vtvChanEpgAt.set(cid, Date.now());
      return grouped[cid].length;
    }
    return 0;
  } finally {
    vtvChanEpgPending.delete(cid);
  }
}

function vtvEpgFresh() {
  const nowMs = Date.now();
  let best = 0;
  for (const k of Object.keys(epgBySrc.vodafone)) {
    const rows = epgBySrc.vodafone[k];
    if (rows && rows.length && rows[rows.length - 1].e2 > best) best = rows[rows.length - 1].e2;
  }
  return best > nowMs;
}

function vtvEnsureEpg(force) {
  if (vtvEpgP) return vtvEpgP;
  vtvEpgP = (async () => {
    try {
      if (!(authMeta.vodafone && authMeta.vodafone.logged)) return 0;
      if (!force && vtvEpgFresh()) return -1;
      const n = await vtvLoadEpg();
      log('Vodafone TV EPG: program pro ' + n + ' stanic');
      if (n > 0) scanEpgWatches('vodafone');
      return n;
    } finally { vtvEpgP = null; }
  })();
  return vtvEpgP;
}

async function vtvPlayUrl(st, opts = {}) {
  const cfg = await vtvEnsureConfig();
  const sess = await vtvEnsureSession();
  const isCatchup = !!opts.epgId;
  const assetId = isCatchup ? String(opts.epgId) : String(st.vfId);
  const assetType = isCatchup ? 'epg' : 'media';
  const context = isCatchup ? 'CATCHUP' : 'PLAYBACK';
  const reqBody = {
    assetId,
    assetType,
    contextDataParams: {
      objectType: 'KalturaPlaybackContextOptions',
      assetFileIds: String(st.vfFileId),
      context,
      urlType: 'DIRECT',
    },
    apiVersion: cfg.apiVersion,
    ks: sess.ks,
  };
  const postBody = { ...reqBody };
  if (sess.cdnTokens && sess.cdnTokens.length) postBody.cdnCts = sess.cdnTokens;
  const d = await vtvSignedPost(cfg.phoenix + 'asset/action/getPlaybackManifest', postBody);
  const res = (d && d.result) || {};
  const src = (res.sources && res.sources[0]) || null;
  if (!src || !src.url) {
    const m = (res.messages && res.messages[0]) || {};
    throw new Error(m.message || m.code || 'Vodafone TV nevrátil URL streamu.');
  }
  const drmItem = (src.drm && src.drm[0]) || null;
  // getPlaybackManifest nevraci pole src.drm (na rozdil od getPlaybackContext), protoze vsechny DASH streamy
  // Vodafone TV CZ pouzivaji Nagra SSM Widevine.
  const isDash = /\.mpd(\?|$)/i.test(src.url) || /DASH/i.test(String(st.vfFileType || ''));
  const clearContent = !drmItem && !isDash;
  let host = '';
  try { host = new URL(src.url).host; } catch {}
  log('Vodafone manifest OK: ' + st.name + ' host=' + host + ' drm=' + (clearContent ? 'clear' : (drmItem?.scheme || 'SSM-Widevine')), 'INFO', 'VTV');
  const curProg = !isCatchup ? liveInfo(st) : null;
  const progRow = !isCatchup ? (epgRowsFor(st) || []).find((r) => r.s <= Date.now() && r.e2 > Date.now()) : null;
  return {
    url: src.url,
    clearContent,
    drmToken: (drmItem && drmItem.data) || '',
    reqBody,
    assetId,
    assetType,
    fileId: String(st.vfFileId),
    programId: isCatchup ? null : (progRow && progRow.id ? progRow.id : (curProg && curProg.id ? curProg.id : null)),
  };
}

function vtvBookmarkOf(ssm, action) {
  const pos = (ssm.assetType === 'epg' && Number.isFinite(video.currentTime)) ? video.currentTime : 0;
  return buildVodafoneBookmarkBody({
    assetId: ssm.assetId,
    assetType: ssm.assetType,
    fileId: ssm.fileId,
    action,
    position: pos,
    programId: ssm.programId,
    apiVersion: vtvCfg ? vtvCfg.apiVersion : '5.3.2',
    ks: vtvSession ? vtvSession.ks : '',
  });
}

const VTV_SSM_STORAGE_KEY = 'tvklient.vtvSsmPending';
let vtvSsmStopP = null;

function vtvSavePendingSsm(sessionToken, bookmarkBody) {
  try {
    if (sessionToken) localStorage.setItem(VTV_SSM_STORAGE_KEY, JSON.stringify({ sessionToken, bookmarkBody }));
    else localStorage.removeItem(VTV_SSM_STORAGE_KEY);
  } catch {}
}

async function vtvTearDownPending() {
  let saved = null;
  try {
    const raw = localStorage.getItem(VTV_SSM_STORAGE_KEY);
    if (raw) {
      localStorage.removeItem(VTV_SSM_STORAGE_KEY);
      saved = JSON.parse(raw);
    }
  } catch {}
  if (!saved || !saved.sessionToken || !vtvCfg || !vtvSession) return;
  try {
    const bm = saved.bookmarkBody && typeof saved.bookmarkBody === 'object'
      ? { ...saved.bookmarkBody, ks: vtvSession.ks }
      : buildVodafoneBookmarkBody({ assetId: '', assetType: 'media', fileId: 0, action: 'STOP', position: 0, apiVersion: vtvCfg.apiVersion, ks: vtvSession.ks });
    await vtvSignedPost(vtvCfg.vtvApiGw + 'ccursession/v1/teardown', {
      requests: [
        { action: 'bookmark', params: {}, body: bm },
        { action: 'session', params: { sessionToken: saved.sessionToken }, body: {} },
      ],
    }, false);
    log('Vodafone SSM teardown (uložená relace) OK', 'INFO', 'VTV');
  } catch (e) {
    log('Vodafone SSM teardown (uložená relace): ' + (e?.message || e), 'WARN', 'VTV');
  }
}

async function vtvSsmStop() {
  if (vtvSsmStopP) {
    await vtvSsmStopP.catch(() => {});
  }
  const s = vtvSsm;
  vtvSsm = null;
  if (!s) return;
  if (s.timer) { clearInterval(s.timer); s.timer = null; }
  if (!s.sessionToken || !vtvCfg || !vtvSession) return;
  const bm = vtvBookmarkOf(s, 'STOP');
  vtvSavePendingSsm(s.sessionToken, bm);
  vtvSsmStopP = (async () => {
    try {
      await vtvSignedPost(vtvCfg.vtvApiGw + 'ccursession/v1/teardown', {
        requests: [
          { action: 'bookmark', params: {}, body: bm },
          { action: 'session', params: { sessionToken: s.sessionToken }, body: {} },
        ],
      }, false);
      vtvSavePendingSsm(null);
    } catch (e) {
      log('Vodafone SSM teardown: ' + (e?.message || e), 'WARN', 'VTV');
    } finally {
      vtvSsmStopP = null;
    }
  })();
  await vtvSsmStopP;
}

function installVtvXhrInterceptor() {
  if (vtvXhrHooked) return;
  vtvXhrHooked = true;
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__vtvUrl = typeof url === 'string' ? url : String(url || '');
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (this.__vtvUrl && this.__vtvUrl.startsWith(VTV_SSM_LICENSE_URL)) {
      const xhr = this;
      const u8 = body instanceof ArrayBuffer
        ? new Uint8Array(body)
        : (ArrayBuffer.isView(body) ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength) : new Uint8Array(0));
      const chalB64 = bytesToB64(u8);
      vtvHandleLicenseChallenge(chalB64).then((licB64) => {
        const bin = atob(licB64);
        const buf = new ArrayBuffer(bin.length);
        const view = new Uint8Array(buf);
        for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
        Object.defineProperty(xhr, 'readyState', { value: 4, configurable: true });
        Object.defineProperty(xhr, 'status', { value: 200, configurable: true });
        Object.defineProperty(xhr, 'statusText', { value: 'OK', configurable: true });
        Object.defineProperty(xhr, 'response', { value: buf, configurable: true });
        Object.defineProperty(xhr, 'responseURL', { value: xhr.__vtvUrl, configurable: true });
        xhr.getResponseHeader = (h) => (/content-type/i.test(String(h || '')) ? 'application/octet-stream' : null);
        xhr.getAllResponseHeaders = () => 'content-type: application/octet-stream\r\n';
        try { xhr.dispatchEvent(new Event('readystatechange')); } catch {}
        try { xhr.dispatchEvent(new Event('load')); } catch {}
        try { xhr.dispatchEvent(new Event('loadend')); } catch {}
      }).catch((e) => {
        log('Vodafone Widevine licence selhala: ' + (e?.message || e));
        Object.defineProperty(xhr, 'readyState', { value: 4, configurable: true });
        Object.defineProperty(xhr, 'status', { value: 500, configurable: true });
        Object.defineProperty(xhr, 'statusText', { value: 'Error', configurable: true });
        Object.defineProperty(xhr, 'response', { value: new ArrayBuffer(0), configurable: true });
        try { xhr.dispatchEvent(new Event('readystatechange')); } catch {}
        try { xhr.dispatchEvent(new Event('error')); } catch {}
        try { xhr.dispatchEvent(new Event('loadend')); } catch {}
      });
      return;
    }
    return origSend.call(this, body);
  };
}

async function vtvPrepareSsmForPlay(st) {
  installVtvXhrInterceptor();
  await vtvSsmStop();
  await vtvTearDownPending();
  const play = st._vtvPlay;
  if (!play) throw new Error('Chybí playback kontext pro Vodafone TV.');
  vtvSsm = {
    sessionToken: null,
    heartbeat: 60,
    timer: null,
    reqBody: play.reqBody,
    assetId: play.assetId,
    assetType: play.assetType,
    fileId: play.fileId,
    programId: play.programId,
    station: st,
    licensed: false,
  };
}

function vtvStartHeartbeat(ssm) {
  if (ssm.timer) { clearInterval(ssm.timer); ssm.timer = null; }
  const sec = Math.max(15, Number(ssm.heartbeat) || 60);
  ssm.timer = setInterval(async () => {
    if (vtvSsm !== ssm || !ssm.sessionToken) { clearInterval(ssm.timer); ssm.timer = null; return; }
    try {
      const bm = vtvBookmarkOf(ssm, paused ? 'PAUSE' : 'HIT');
      const r = await vtvSignedPost(vtvCfg.vtvApiGw + 'ccursession/v1/renewal', {
        requests: [
          { action: 'bookmark', params: {}, body: bm },
          { action: 'session', params: { sessionToken: ssm.sessionToken }, body: {} },
          { action: 'license', params: {}, body: {} },
        ],
      });
      if (r && r.sessionToken) {
        ssm.sessionToken = r.sessionToken;
        vtvSavePendingSsm(r.sessionToken, vtvBookmarkOf(ssm, 'STOP'));
      }
    } catch (e) {
      log('Vodafone SSM heartbeat: ' + (e?.message || e));
    }
  }, sec * 1000);
}

async function vtvHandleLicenseChallenge(challengeB64) {
  const ssm = vtvSsm;
  if (!ssm || !vtvCfg) throw new Error('Vodafone SSM relace není připravena.');
  log('Vodafone SSM licence request (licensed=' + ssm.licensed + ', chalLen=' + challengeB64.length + ')', 'INFO', 'VTV');
  const licParams = { drmId: VODAFONE_WIDEVINE_DRM_ID, challenge: challengeB64 };
  if (!ssm.licensed) {
    const bm = vtvBookmarkOf(ssm, 'PLAY');
    let r;
    try {
      r = await vtvSignedPost(vtvCfg.vtvApiGw + 'ccursession/v1/start', {
        requests: [
          { action: 'checkEntitlement', params: {}, body: ssm.reqBody || {} },
          { action: 'bookmark', params: {}, body: bm },
          { action: 'session', params: {}, body: {} },
          { action: 'license', params: licParams, body: {} },
        ],
      });
    } catch (e) {
      const m = String(e?.message || e);
      const code = String(e?.vtvCode || '');
      log('Vodafone SSM start selhal (HTTP ' + (e?.httpStatus || '?') + ' code=' + code + '): ' + m, 'ERROR', 'VTV');
      if (e?.httpStatus === 403 || /NotEntitled|3032|ServiceNotAllowed|forbidden/i.test(m + ' ' + code)) {
        if (ssm.station) {
          ssm.station.locked = true;
          ssm.station.noAccess = true;
          persistCache();
          renderStations();
        }
        toast('Stanice není ve vašem balíčku.', 6000);
        setTimeout(() => stopStream(), 0);
      } else if (/ConcurrencyLimitation|MediaConcurrencyLimitation/i.test(m + ' ' + code)) {
        toast('Překročen limit souběžných streamů Vodafone TV.', 8000);
        setTimeout(() => stopStream(), 0);
      }
      throw e;
    }
    if (!r || !r.license) {
      log('Vodafone SSM start bez licence, klíče: ' + Object.keys(r || {}).join(','), 'ERROR', 'VTV');
      throw new Error('Vodafone SSM start nevrátil Widevine licenci.');
    }
    ssm.licensed = true;
    if (r.sessionToken) {
      ssm.sessionToken = r.sessionToken;
      vtvSavePendingSsm(r.sessionToken, vtvBookmarkOf(ssm, 'STOP'));
    }
    if (Number(r.heartBeat || r.heartbeat) > 0) ssm.heartbeat = Number(r.heartBeat || r.heartbeat);
    vtvStartHeartbeat(ssm);
    log('Vodafone SSM start OK (licLen=' + r.license.length + ', hb=' + ssm.heartbeat + 's)', 'INFO', 'VTV');
    return r.license;
  }
  const bm = vtvBookmarkOf(ssm, paused ? 'PAUSE' : 'HIT');
  const r = await vtvSignedPost(vtvCfg.vtvApiGw + 'ccursession/v1/renewal', {
    requests: [
      { action: 'bookmark', params: {}, body: bm },
      { action: 'session', params: { sessionToken: ssm.sessionToken || '' }, body: {} },
      { action: 'license', params: licParams, body: {} },
    ],
  });
  if (!r || !r.license) throw new Error('Vodafone SSM renewal nevrátil Widevine licenci.');
  if (r.sessionToken) ssm.sessionToken = r.sessionToken;
  return r.license;
}

window.addEventListener('beforeunload', () => { vtvSsmStop().catch(() => {}); });

async function vtvSilentLogin(loadData = true) {
  const user = await vaultGet('vodafone.username');
  const pass = await vaultGet('vodafone.password');
  if (!user || !pass) return false;
  try {
    await vtvBeginLogin(user, pass);
  } catch (e) {
    log('Vodafone TV silent login: ' + (e?.message || e));
    return false;
  }
  authMeta.vodafone = { logged: true, updatedAt: Date.now() };
  if (loadData) {
    vtvEnsureEpg().then((n) => { if (n > 0) renderAll(); }).catch(() => {});
    try {
      const list = await vtvLoadChannels();
      if (list.length) { liveChannels.vodafone = list; log('Vodafone TV: kanály obnoveny (' + list.length + ')'); }
    } catch (e) { log('Vodafone TV: kanály se nepodařilo obnovit: ' + (e?.message || e)); }
  }
  return true;
}

// ---------- modalni prihlaseni: jmeno+heslo -> (profily) -> zpet ----------
// SledovaniTV a Vodafone TV profily nemaji (jdou rovnou), Oneplay ukaze serverove profily.
let loginFor = null;
let connecting = { sltv: false, oneplay: false, vodafone: false };
let connectingCount = { sltv: 0, oneplay: 0, vodafone: 0 };
async function withConnecting(id, fn) {
  connectingCount[id] = (connectingCount[id] || 0) + 1;
  connecting[id] = true; renderSources();
  try { return await fn(); }
  finally {
    connectingCount[id] = Math.max(0, (connectingCount[id] || 1) - 1);
    connecting[id] = connectingCount[id] > 0; renderSources();
  }
}
const loginModal = () => $('#loginModal');
function loginShowStep(name) {
  for (const s of ['Creds', 'Profiles']) {
    document.getElementById('loginStep' + s).style.display = s === name ? '' : 'none';
  }
}
async function openLoginModal(id) {
  loginFor = id;
  $('#loginTitle').textContent = 'Přihlášení – ' + srcOf(id).name;
  $('#loginCredsText').innerHTML = id === 'sltv'
    ? 'Zadej e-mail a heslo <b>jednou</b>. Aplikace si spáruje zařízení a dál se přihlašuje sama.'
    : id === 'vodafone'
      ? 'Zadej jméno a heslo <b>jednou</b>. Údaje se bezpečně uloží do trezoru.'
      : 'Zadej e-mail / O2 ID a heslo <b>jednou</b>. Pak vybereš profil; dál je vše automatické.';
  document.getElementById('loginErr').classList.remove('on');
  $('#loginPass').value = '';
  loginModal().classList.add('on');
  if (id === 'vodafone') {
    const user = await vaultGet('vodafone.username');
    $('#loginUser').value = user || '';
  }
  if (id === 'oneplay') {
    const user = await vaultGet('oneplay.username');
    const pass = await vaultGet('oneplay.password');
    if (user) $('#loginUser').value = user;
    if (user && pass) {
      loginShowStep('Profiles');
      $('#profileTitle').textContent = 'Načítám…';
      $('#profileList').innerHTML = '';
      try {
        const r = await oneplayBeginLogin(user, pass);
        if (r.accounts) {
          showChoiceStep('Vyber účet', r.accounts.map((a) => ({ id: a.id, name: a.name + (a.suffix ? ' (' + a.suffix + ')' : ''), avatar: null })),
            (acc) => doOneplayAccount(acc.id, r.authToken, user, pass));
          return;
        }
        const profiles = await oneplayProfiles(r.token);
        pendingOneplay = { token: r.token };
        showChoiceStep('Kdo sleduje? (Oneplay)', profiles, pickOneplayProfile);
        return;
      } catch (e) { log('uložené přihlášení neprošlo, zadej znovu: ' + (e?.message || e)); }
    }
  }
  loginShowStep('Creds');
  setTimeout(() => $('#loginUser').focus(), 50);
}
function closeLoginModal() { loginModal().classList.remove('on'); loginFor = null; pendingOneplay = null; }
function showLoginError(msg) {
  document.getElementById('loginErrText').textContent = msg;
  document.getElementById('loginErr').classList.add('on');
  const card = document.getElementById('loginCard');
  card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
  const u = document.getElementById('loginUser'), pw = document.getElementById('loginPass');
  (u.value ? pw : u).focus();
}
let pendingOneplay = null; // {token} behem vyberu profilu/uctu
function showChoiceStep(title, items, onPick) {
  $('#profileTitle').textContent = title;
  const w = $('#profileList'); w.innerHTML = '';
  items.forEach((p) => {
    const d = document.createElement('div'); d.className = 'prof';
    const av = p.avatar
      ? '<div class="ava"><img src="' + p.avatar + '" alt=""></div>'
      : '<div class="ava" style="background:' + (p.color || '#2563eb') + '">' + (p.name || '?')[0] + '</div>';
    d.innerHTML = av + '<div class="pname">' + p.name + '</div>';
    d.onclick = async () => {
      w.querySelectorAll('.prof').forEach((x) => { x.style.pointerEvents = 'none'; x.style.opacity = '.6'; });
      try { await onPick(p); }
      catch (e) {
        w.querySelectorAll('.prof').forEach((x) => { x.style.pointerEvents = ''; x.style.opacity = ''; });
        toast('Nezdařilo se: ' + (e?.message || e));
        log('vyber selhal: ' + (e?.message || e));
      }
    };
    w.appendChild(d);
  });
  loginShowStep('Profiles');
}
$('#btnCloseLogin').onclick = closeLoginModal;
document.getElementById('loginUser').addEventListener('input', () => document.getElementById('loginErr').classList.remove('on'));
document.getElementById('loginPass').addEventListener('input', () => document.getElementById('loginErr').classList.remove('on'));
$('#btnCloseLogin2').onclick = closeLoginModal;
$('#btnBackToCreds').onclick = () => loginShowStep('Creds');
$('#btnDoLogin').onclick = async () => {
  const id = loginFor;
  const user = $('#loginUser').value.trim(), pass = $('#loginPass').value;
  if (!user || !pass) { showLoginError('Vyplň jméno i heslo.'); return; }
  $('#btnDoLogin').disabled = true;
  try {
    await withConnecting(id, async () => {
      if (id === 'sltv') await doSltvLogin(user, pass);
      else if (id === 'vodafone') await doVodafoneLogin(user, pass);
      else await doOneplayLogin(user, pass);
    });
  } catch (e) {
    showLoginError('Nepodařilo se přihlásit: ' + (e?.message || e));
  } finally { $('#btnDoLogin').disabled = false; }
};
async function doSltvLogin(user, pass) {
  // Udaje patri do trezoru hned po stisku Prihlasit, pred samotnym parovanim.
  await vaultSet('sltv.username', user);
  await vaultSet('sltv.password', pass);
  log('páruji zařízení SledováníTV…');
  await sltvPair(user, pass);
  const list = await sltvLoadChannels();
  liveChannels.sltv = list;
  authMeta.sltv = { logged: true, updatedAt: Date.now() };
  debugDump('epg-login', list);
  await storeSet('authMeta', authMeta);
  persistCache();
  closeLoginModal();
  if (curSrc !== 'sltv') { curSrc = 'sltv'; selIdx = 0; }
  paused = false;
  renderAll();
  const st = currentStation();
  if (st) playStation(st, false);
  log('SledováníTV přihlášeno (' + list.length + ' stanic)');
}
async function doVodafoneLogin(user, pass) {
  // Udaje patri do trezoru hned po stisku Prihlasit, pred samotnym loginem.
  await vaultSet('vodafone.username', user);
  await vaultSet('vodafone.password', pass);
  log('přihlašuji Vodafone TV…');
  await vtvBeginLogin(user, pass);
  authMeta.vodafone = { logged: true, updatedAt: Date.now() };
  const [list] = await Promise.all([
    vtvLoadChannels(),
    vtvEnsureEpg(true).catch((e) => { log('Vodafone TV EPG: ' + (e?.message || e)); return 0; }),
  ]);
  liveChannels.vodafone = list;
  await storeSet('authMeta', authMeta);
  persistCache();
  closeLoginModal();
  if (curSrc !== 'vodafone') { curSrc = 'vodafone'; selIdx = 0; }
  paused = false;
  renderAll();
  applySelection(false);
  log('Vodafone TV přihlášeno (' + list.length + ' kanálů)');
}
// Jednorazova migrace: co drive skoncilo v docasnem localStorage fallbacku,
// presun do opraveneho Rust trezoru a fallback vycisti.
async function migrateVault() {
  if (!invoke) return;
  const keys = ['sltv.deviceId', 'sltv.devicePass', 'sltv.token', 'sltv.token_ts', 'sltv.username', 'sltv.password',
    'oneplay.username', 'oneplay.password', 'oneplay.token', 'oneplay.token_ts', 'oneplay.profileId', 'oneplay.profileName'];
  for (const k of keys) {
    try {
      const existing = await invoke('vault_get', { key: k }).catch(() => null);
      if (existing !== null && existing !== undefined) continue;
      const legacy = localStorage.getItem('tvklient.vault.' + k);
      if (legacy !== null && legacy !== undefined) {
        await invoke('vault_set', { key: k, value: legacy });
        localStorage.removeItem('tvklient.vault.' + k);
        log('trezor: premigrovano ' + k);
      }
    } catch (e) { log('trezor: migrace ' + k + ' selhala: ' + (e?.message || e)); }
  }
}

// ---------- perzistence nastaveni ----------
let persistT = null;
function snapshotState() {
  return {
    source: curSrc,
    station: currentStation() ? currentStation().name : null,
    selBySrc: selBySrc && typeof selBySrc === 'object' ? { ...selBySrc } : {},
    paused: paused === true,
    favBySrc: { sltv: [...(favBySrc.sltv || [])], oneplay: [...(favBySrc.oneplay || [])], vodafone: [...(favBySrc.vodafone || [])] },
    srcCollapsed: srcCollapsed === true,
    vol: Math.max(0, Math.min(100, Math.round(appVol))),
    muted: appMuted === true,
    reminders: { ...reminders },
    everPlayed: everPlayed === true,
    epgSearchOtherCh: epgSearchOtherCh !== false,
    epgSearchOtherSrc: epgSearchOtherSrc === true,
    epgSearchDesc: epgSearchDesc === true,
    epgWatches: Array.isArray(epgWatches) ? epgWatches : [],
  };
}
async function persistNow() {
  const snap = snapshotState();
  try { // synchronni cast probehne vzdy, i pri okamzitem zavreni okna
    const all = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    Object.assign(all, snap);
    localStorage.setItem(LS_KEY, JSON.stringify(all));
  } catch {}
  for (const [k, v] of Object.entries(snap)) await storeSet(k, v).catch(() => {});
}
function persistSoon() {
  clearTimeout(persistT);
  persistT = setTimeout(() => { persistNow().catch(() => {}); }, 300);
}
function slimChannel(st) {
  if (!st || typeof st !== 'object') return null;
  // Bez volatilnich EPG poli (now/pct/epg) — ta se vzdy prepocitaji z cerstvych dat, stara cache nesmi lhát.
  return {
    eid: st.eid || null, opId: st.opId || null,
    vfId: st.vfId || null, vfEpgId: st.vfEpgId || null, vfFileId: st.vfFileId || null, vfFileType: st.vfFileType || null,
    timeshift: st.timeshift || 0,
    name: st.name, ini: st.ini, color: st.color,
    logo: st.logo || null, locked: !!st.locked, noAccess: !!st.noAccess, order: st.order || 0,
  };
}
function stripVolatileEpgs(list) {
  // Stare cache nesly zadny program — po nacteni se doplni z EPG.
  if (!Array.isArray(list)) return;
  for (const s of list) { if (s && typeof s === 'object') { s.now = ''; s.pct = null; delete s.epg; } }
}
function persistCache() {
  // Uklada se jen metadata (bez stream URL — stejne expiruji); male a rychle.
  const slim = {};
  for (const [src, list] of Object.entries(liveChannels || {})) {
    if (Array.isArray(list)) slim[src] = list.map(slimChannel).filter(Boolean);
  }
  storeSet('chanCache', slim);
}

// ---------- startovaci logika ----------
let APP_BUILD = '?';
async function restore() {
  try {
    if (invoke) {
      const dbg = await invoke('vault_debug');
      if (!dbg || dbg.write !== 'ok') toast('Diagnostika úložiště: ' + JSON.stringify(dbg), 12000);
      else log('úložiště OK: ' + dbg.dir);
      try {
        const b = await invoke('app_build');
        APP_BUILD = 'v' + b.version + ' #' + b.time;
        log('build: ' + APP_BUILD);
        const tag = document.getElementById('buildTag');
        if (tag) tag.textContent = 'build ' + APP_BUILD;
        const hv = document.getElementById('helpVer');
        const hd = document.getElementById('helpDate');
        if (hv) hv.innerHTML = '<b>TV Client</b> · v' + b.version;
        if (hd && b.time) {
          const d = new Date(Number(b.time) * 1000);
          hd.textContent = isNaN(d.getTime()) ? ('Release: ' + b.time) : ('Release: ' + d.getDate() + '. ' + (d.getMonth() + 1) + '. ' + d.getFullYear());
        }
      } catch {}
    }
  } catch (e) { toast('Diagnostika úložiště selhala: ' + (e?.message || e), 12000); }
  await storeInit();
  await migrateVault();
  curSrc = (await storeGet('source')) || 'sltv';
  if (!SOURCES.find((s) => s.id === curSrc)) curSrc = 'sltv';
  // Sanitizace: z uloziste bereme jen tvarove platne hodnoty (poskozeny soubor nesmi nic smazat).
  // Serial zarizeni musi byt i na disku (nejen v mirroru), jinak by se po ztrate profilu zbytecne parovalo znovu.
  try {
    const ser = await storeGet('sltv.serial');
    if (ser) await storeSet('sltv.serial', ser);
  } catch {}
  reminders = await storeGet('reminders');
  if (!reminders || typeof reminders !== 'object' || Array.isArray(reminders)) reminders = {};
  else {
    for (const k of Object.keys(reminders)) {
      const r = reminders[k];
      if (!r || typeof r !== 'object' || typeof r.src !== 'string' || !r.s) delete reminders[k];
    }
  }
  cleanupReminders();
  paused = (await storeGet('paused')) === true;
  // Sbaleni zdroju a hlasitost: trvale stavy jako vsechno ostatni.
  srcCollapsed = (await storeGet('srcCollapsed')) === true;
  syncSrcCollapsed();
  appVol = Math.max(0, Math.min(100, +(await storeGet('vol')) || 80));
  appMuted = (await storeGet('muted')) === true;
  applyVol();
  everPlayed = (await storeGet('everPlayed')) === true;
  const savedOtherCh = await storeGet('epgSearchOtherCh');
  epgSearchOtherCh = (savedOtherCh === null || savedOtherCh === undefined) ? true : savedOtherCh === true;
  epgSearchOtherSrc = (await storeGet('epgSearchOtherSrc')) === true;
  epgSearchDesc = (await storeGet('epgSearchDesc')) === true;
  syncEpgFilterOpts();
  const savedWatches = await storeGet('epgWatches');
  epgWatches = Array.isArray(savedWatches)
    ? savedWatches.filter((w) => w && typeof w === 'object' && typeof w.q === 'string' && w.q.trim().length >= 2)
    : [];
  cleanupEpgWatches();
  renderEpgWatches();
  checkSnoozedWatches();
  persistSoon(); // prepsat pripadne poskozeny soubor cistymi hodnotami
  authMeta = await storeGet('authMeta');
  if (!authMeta || typeof authMeta !== 'object' || Array.isArray(authMeta)) authMeta = { sltv: null, oneplay: null, vodafone: null };
  else {
    for (const k of ['sltv', 'oneplay', 'vodafone']) {
      if (authMeta[k] !== null && authMeta[k] !== undefined && typeof authMeta[k] !== 'object') authMeta[k] = null;
    }
  }
  const cache = await storeGet('chanCache');
  const chanOk = cache && typeof cache === 'object';
  const chan = chanOk ? cache : {};
  // Stara cache bez playlist id (eid) neumela sparovat EPG -> zahodit.
  if (Array.isArray(chan.sltv) && chan.sltv.length && chan.sltv[0].eid) liveChannels.sltv = chan.sltv;
  else if (chan.sltv?.length) log('cache bez eid zahozena, nacte se cerstve');
  if (Array.isArray(chan.oneplay) && chan.oneplay.length) liveChannels.oneplay = chan.oneplay;
  if (Array.isArray(chan.vodafone) && chan.vodafone.length && chan.vodafone[0].vfId) liveChannels.vodafone = chan.vodafone;
  stripVolatileEpgs(liveChannels.sltv); stripVolatileEpgs(liveChannels.oneplay); stripVolatileEpgs(liveChannels.vodafone);
  // Stara cache mela Oneplay loga v osekavajicim ctverci 256x256 — prepsat na siroky rozmer.
  for (const s of liveChannels.oneplay) {
    if (s && typeof s.logo === 'string' && s.logo.includes('r256x256n')) s.logo = s.logo.replace('r256x256n', 'r320x196n');
  }
  for (const s of liveChannels.vodafone) {
    if (s && typeof s.logo === 'string') s.logo = normalizeKalturaLogoUrl(s.logo);
  }
  // Oblibene: novy per-source format, jinak migrace ze stareho pole jmen (prejmenovani stanic).
  favBySrc = { sltv: [], oneplay: [], vodafone: [] };
  const storedFavs = await storeGet('favBySrc');
  const validFavs = storedFavs && typeof storedFavs === 'object' && ['sltv', 'oneplay'].every((s) => Array.isArray(storedFavs[s]) && storedFavs[s].every((x) => typeof x === 'string'));
  if (validFavs) {
    const vfFavs = Array.isArray(storedFavs.vodafone) ? storedFavs.vodafone.filter((x) => typeof x === 'string') : [];
    favBySrc = { sltv: [...storedFavs.sltv], oneplay: [...storedFavs.oneplay], vodafone: vfFavs };
    // Jednorazovy uklid stareho formatu po probehle migraci.
    storeGet('favs').then((v) => { if (v !== null && v !== undefined) storeDelete('favs').catch(() => {}); }).catch(() => {});
  }
  else {
    const oldFavs = await storeGet('favs');
    if (Array.isArray(oldFavs) && oldFavs.length) {
      const { out, dropped } = migrateFavKeys(oldFavs);
      favBySrc = out;
      const got = out.sltv.length + out.oneplay.length;
      log('oblíbené převedeny na zdroje: sltv ' + out.sltv.length + ', oneplay ' + out.oneplay.length + (dropped.length ? '; nepřiřazeno: ' + dropped.join(', ') : ''));
      storeDelete('favs').catch(() => {});
      if (!got && !dropped.length) log('opravena poskozena oblibena');
    }
  }
  let savedStation = await storeGet('station');
  if (typeof savedStation !== 'string') savedStation = null;

  // Autoplay hned, jak je VLASTNI zdroj ready — neceka se na druhy zdroj.
  async function maybeAutoplay(src) {
    if (autoplayed || curSrc !== src) return;
    const st = currentStation();
    if (!st || (!st.streamUrl && !st.opId && !st.vfId)) return;
    // Pauza: nic nepoustet ani nemazat — obraz pripravi finalni boot blok (jinak by zustal sum).
    if (paused) return;
    autoplayed = true;
    try { await applySelection(true); } catch {}
    if (!video.classList.contains('on') && !paused) {
      // Prechodne selhani (napr. Oneplay content.play pri startu): jeden tichy retry po 3 s.
      setTimeout(async () => {
        if (video.classList.contains('on') || paused || curSrc !== src) return;
        if (!(await checkNetOnline())) { enterOffline('boot'); return; }
        try { await applySelection(true); } catch {}
      }, 3000);
    }
  }
  // Tiche obnoveni sezeni (trezor): oba zdroje paralelne, kazdy s vlastnim stavem pripojovani.
  async function bootSltv() {
    try {
      const list = await withConnecting('sltv', sltvLoadChannels);
      if (list.length) {
        liveChannels.sltv = list;
        authMeta.sltv = { logged: true, updatedAt: Date.now() };
        log('SledováníTV: sezení obnoveno (' + list.length + ' stanic)');
      }
      debugDump('epg-restore', list);
  } catch (e) {
    const msg = String(e?.message || e);
    // Kopii zahodit JEN pri dukazu neplatneho sezeni; vypadky site a chyby serveru (HTTP 5xx) ji nechavaji.
    const authDead = /bad login|not.?logged|\b401\b|\b403\b|neplatn|expir|pairing selhalo|device-login odm|Spárování odmítnuto|Obnovení sezení selhalo|Chybí spárování|prázdný/i.test(msg);
    if (!authDead) {
      console.debug('[tv] tichá obnova selhala, zkouším uložená data:', msg);
      log('Server SledováníTV teď neodpovídá — zkouším uložená data.');
    } else {
      const wasLogged = !!(authMeta.sltv && authMeta.sltv.logged);
      liveChannels.sltv = [];
      epgBySrc.sltv = {};
      invalidateEpgSearch('sltv');
      authMeta.sltv = null;
      selIdx = 0;
      persistCache();
      await storeSet('authMeta', authMeta);
      console.debug('[tv] sezení neplatné, kopie zahozena:', msg);
      log('Sezení SledováníTV neplatí — přihlas se prosím znovu.');
      if (wasLogged) toast('SledováníTV: sezení vypršelo — přihlas se prosím znovu.', 10000);
    }
  }
  maybeAutoplay('sltv').catch(() => {});
  }
  async function bootOneplay() {
    // Pri startu zadny novy login — staci ulozena kopie, prihlaseni probehne lenive pri prvnim pouziti.
    // Nove sezeni jen kdyz neni vubec co ukazat.
    // Probuzení po dlouhé odmlce (PC spal / aplikace byla vypnuta): pri prvnim pokusu nemusi
  // byt sit nahore, tak to za 30 s zkusi znovu — kdyz selze, preplánují se pripomínky,
  // aby se to stejně vyriešilo.
  // Po vypnuti/odmlce: naplanovane pripinute je treba obslouzit ihned (jestlize jeste bezi)
  // ci preplanovat. Bootova akce applySelection(true), takze v tichém rezimu.
  const wokeUp = Date.now() - lastTick > 3 * 60e3;
  if (wokeUp) setTimeout(() => { if (!recovering) wakeRecovery('wake-retry'); }, 30000);
  lastTick = Date.now();
  const wasOpLogged = !!(authMeta.oneplay && authMeta.oneplay.logged);
    if (!liveChannels.oneplay.length) {
      try {
        const ok = await withConnecting('oneplay', oneplaySilentLogin);
        if (ok) log('Oneplay: sezení obnoveno');
      } catch (e) {
        console.debug('[tv] Oneplay silent login:', (e?.message || e));
        log('Oneplay se tiše nepřihlásilo — zkus to prosím ručně tlačítkem Přihlásit.');
        authMeta.oneplay = null;
      }
    } else if (authMeta.oneplay) {
      log('Oneplay: používám uložené sezení (nové až při selhání)');
    }
    if (wasOpLogged && !(authMeta.oneplay && authMeta.oneplay.logged)) {
      toast('Oneplay: sezení vypršelo — přihlas se prosím znovu.', 10000);
    }
    // Jakmile mame stanice z cache (s opId), spustit stream ihned; cerstve kanaly a EPG dotahnout na pozadi.
    if (authMeta.oneplay && authMeta.oneplay.logged && liveChannels.oneplay.length) {
      maybeAutoplay('oneplay').catch(() => {});
    }
    // EPG se pri startu cerstve dotahne na pozadi paralelne s dotazenim cerstvych kanalu, aniz by blokovalo spusteni streamu.
    if (authMeta.oneplay && authMeta.oneplay.logged) {
      withConnecting('oneplay', () => oneplayEnsureEpg(true))
        .then((n) => { if (n > 0) { persistCache(); renderAll(); } })
        .catch((e) => { log('Oneplay EPG: ' + (e?.message || e)); });
    }
    if (authMeta.oneplay && authMeta.oneplay.logged && liveChannels.oneplay.length && !liveChannels.oneplay.some((s) => s.streamUrl)) {
      try {
        const t = await vaultGet('oneplay.token');
        const pid = authMeta.oneplay.profileId || await vaultGet('oneplay.profileId');
        if (t && pid) {
          const fresh = await withConnecting('oneplay', () => oneplayChannels(t, pid));
          if (fresh.length) { liveChannels.oneplay = fresh; persistCache(); log('Oneplay: kanály dohrány'); }
        }
      } catch (e) { log('Oneplay: čerstvé kanály selhaly: ' + (e?.message || e)); }
    }
    maybeAutoplay('oneplay').catch(() => {});
  }
  async function bootVodafone() {
    const hasCreds = !!(await vaultGet('vodafone.username')) && !!(await vaultGet('vodafone.password'));
    if (!hasCreds) return;
    const wasVfLogged = !!(authMeta.vodafone && authMeta.vodafone.logged);
    try {
      const ok = await withConnecting('vodafone', () => vtvSilentLogin(true));
      if (ok) {
        persistCache();
        log('Vodafone TV: sezení obnoveno (' + liveChannels.vodafone.length + ' kanálů)');
      } else if (wasVfLogged && !liveChannels.vodafone.length) {
        log('Vodafone TV se tiše nepřihlásilo — zkus to ručně tlačítkem Přihlásit.');
      }
    } catch (e) {
      log('Vodafone TV boot: ' + (e?.message || e));
    }
    maybeAutoplay('vodafone').catch(() => {});
  }
  selBySrc = await storeGet('selBySrc');
  if (!selBySrc || typeof selBySrc !== 'object') selBySrc = {};
  const wantStation = selBySrc[curSrc] || savedStation;
  if (wantStation) {
    const i = channels().findIndex((s) => s.name === wantStation);
    if (i >= 0) selIdx = i;
  }
  if (currentStation()) selBySrc[curSrc] = currentStation().name;
  bootSelIdx = selIdx; bootSrc = curSrc;
  renderAll(); // rychle ukazat cache, nez se dotahnou cerstva data
  await Promise.all([bootSltv(), bootOneplay(), bootVodafone()]);
  persistCache();
  await storeSet('authMeta', authMeta);
  renderAll();
  // Po startu nezustava pripnuty panel, pokud na nem neni mys (updatePin ho pripnul pred nactenim stanic).
  if (currentStation()) {
    if (lastMX < window.innerWidth - 24) document.body.classList.remove('rightOpen');
    if (lastMX > 24) document.body.classList.remove('leftOpen');
  }
  // Autoplay: Oneplay a Vodafone URL se dohledava az pri prehrani (applySelection), staci opId/vfId.
  // Bez rucni zmeny behem bootu (jinak plati volba uzivatele, maybeAutoplay uz hral nebo hraje).
  const st = currentStation();
  const untouched = !autoplayed && selIdx === bootSelIdx && curSrc === bootSrc;
  if (untouched && st && (st.streamUrl || st.opId || st.vfId) && !paused) applySelection(true); // tiche: watchdog to pri neuspechu zkusi znovu
  else if (untouched && st?.streamUrl && paused) { video.src = st.streamUrl; video.classList.add('on'); syncStageVideo(); renderStage(); }
  else if (untouched && paused && st && !st.streamUrl && ((st.opId && authMeta.oneplay && authMeta.oneplay.logged) || (st.vfId && authMeta.vodafone && authMeta.vodafone.logged) || (st.eid && authMeta.sltv && !authMeta.sltv.manual))) {
    // Pauza bez URL (cache): dohledat URL a pripravit zmrazeny obraz, nehrat. Vsechny zdroje stejne.
    video.classList.add('on'); syncStageVideo(); renderStage();
    (async () => {
      const url = await fetchStreamUrl(st);
      if (url) {
        if (st.vfId || (st.drm && window.dashjs)) {
          await playStation(st, true);
        } else {
          video.src = url; video.classList.add('on'); syncStageVideo(); renderStage();
        }
        log('obraz připraven (pauza)');
      } else log('obraz v pauze se nepodařilo připravit');
    })().catch(() => {});
  }
  
  else if (!autoplayed) { wantPlay = false; renderIdle(); }

  if (!authMeta.sltv && !authMeta.oneplay && !authMeta.vodafone) {
    log('zadne uložené přihlášení — vyber si zdroj a klikni Přihlásit');
  }
}

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persistNow().catch(() => {}); });
window.addEventListener('beforeunload', () => { try { persistNow(); } catch {} storeFlush(); });

restoreWinGeometry().then(() => winInfoExfil()).catch(() => {});
watchWinState();
renderAll(); // okamzity prvni render: zadne prazdne sekce pred siti
winInfoExfil();
restore().then(() => {
  log('tv-client spuštěn · zdroj ' + srcOf().name + (currentStation() ? '' : ' · bez přihlášení'));
});
