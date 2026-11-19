// TV klient v0.1.0 — frontend logika (vanilla, bez bundleru).
// Bez demo dat: stanice existuji jen po prihlaseni. Startovaci logika viz restore().

import { normName, matchEpgRows, liveState, parseSltvPlaylist } from './lib/epg.js';

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
const TAURI_INTERNALS = window.__TAURI_INTERNALS__ || null;
const TAURI = window.__TAURI__ || null;
const _invokeFn = (TAURI_INTERNALS && TAURI_INTERNALS.invoke) || (TAURI && TAURI.invoke) || null;
const invoke = _invokeFn ? _invokeFn.bind(TAURI_INTERNALS || TAURI) : null;

const $ = (s) => document.querySelector(s);
const stage = $('#stage'), video = $('#video'), noiseCanvas = $('#noise');
const errToast = $('#errToast');

function log(msg) {
  console.debug('[tv]', msg);
  try {
    const el = document.getElementById('actLog');
    if (!el) return;
    const t = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const d = document.createElement('div');
    d.innerHTML = '<span class="lt">' + p(t.getHours()) + ':' + p(t.getMinutes()) + ':' + p(t.getSeconds()) + '</span>' + String(msg).slice(0, 160);
    el.appendChild(d);
    while (el.children.length > 8) el.firstChild.remove();
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
];
const srcOf = (id) => SOURCES.find((s) => s.id === (id || curSrc));

let curSrc = 'sltv';
let selIdx = 0;
let selBySrc = {}; // zapamatovany vyber stanice pro kazdy zdroj (preziti prepnuti i restartu)
let autoplayed = false, bootSelIdx = 0, bootSrc = 'sltv'; // autoplay probehne jen jednou a jen bez rucni zmeny
let favBySrc = { sltv: [], oneplay: [] }; // oblibene STRIKTNE per-source: 'eid:<id>' | 'op:<id>' | 'name:<jmeno>'
const favKey = (st) => (st.eid ? 'eid:' + st.eid : st.opId ? 'op:' + st.opId : 'name:' + st.name);
const favList = () => favBySrc[curSrc] || (favBySrc[curSrc] = []);
function stationByFav(key) {
  const list = channels();
  if (typeof key !== 'string') return undefined;
  if (key.startsWith('eid:')) { const f = list.find((s) => s.eid && ('eid:' + s.eid) === key); if (f) return f; }
  else if (key.startsWith('op:')) { const f = list.find((s) => s.opId && ('op:' + s.opId) === key); if (f) return f; }
  else if (key.startsWith('name:')) { const f = list.find((s) => s.name === key.slice(5)); if (f) return f; }
  else { const f = list.find((s) => s.name === key); if (f) return f; }
  return undefined;
}
const favHas = (st) => favList().includes(favKey(st));
function findStationEverywhere(pred) {
  for (const src of ['sltv', 'oneplay']) {
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
let liveChannels = { sltv: [], oneplay: [] };  // jen realna data po prihlaseni
let epgBySrc = { sltv: {}, oneplay: {} };      // EPG STRIKTNE per-source, zadne sdileni klicu:
                                              // sltv: {stanice: [...]}, oneplay: {<channelId>: [...]}
let authMeta = { sltv: null, oneplay: null }; // {logged, profileId?, profileName?, manual?, updatedAt}
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
  // Striktne per-source: Oneplay jen svuj store (stejne channelId jako seznam), SledovaniTV jen svuj.
  // Zadny fallback pres jmena mezi zdroji — cizi program je horsi nez zadny.
  if (st.opId) { const r = epgBySrc.oneplay[st.opId]; return r && r.length ? r : null; }
  return matchEpgRows(epgBySrc.sltv, st.name, st.eid);
}
/* Pripominky: zvonecek v radku poradu → v dany cas aplikace sama prepne (vcetne zdroje) a spusti.
   Klic = zdroj|kanal|porad (stabilni id), prošle (po konci poradu) se mazeji. Muze jich byt vic. */
let reminders = {};
const chanKeyOf = (st) => st.eid || st.opId || st.name;
const rowIdOf = (p) => p.id || (p.s ? 's' + p.s : 't' + p.t);
const remKey = (src, st, p) => src + '|' + chanKeyOf(st) + '|' + rowIdOf(p);
function toggleReminder(st, p) {
  const k = remKey(curSrc, st, p);
  if (reminders[k]) { delete reminders[k]; log('⏰ připomínka zrušena: ' + p.title); }
  else {
    reminders[k] = { src: curSrc, chan: chanKeyOf(st), id: rowIdOf(p), title: p.title, t: p.t, s: p.s || 0, e2: p.e2 || 0 };
    log('⏰ připomenutí: ' + st.name + ' – ' + p.title + ' (' + p.t + ')');
  }
  persistSoon();
  const cur = currentStation(); if (cur) renderEpg(cur);
  renderReminders();
}
function cleanupReminders() {
  // Prošlé bez špendlíku se mažou jako dřív; připnuté zůstávají k automatickému přeplánování.
  const now = Date.now();
  let drop = 0;
  for (const k of Object.keys(reminders)) {
    const r = reminders[k];
    if (!r || !r.s) { delete reminders[k]; drop++; }
    else if (r.e2 && r.e2 <= now && !r.pinned) { delete reminders[k]; drop++; }
  }
  if (drop) persistSoon();
  return drop;
}
async function fireReminder(key, r) {
  const wasPinned = !!r.pinned;
  delete reminders[key]; persistSoon();
  if (curSrc !== r.src) curSrc = r.src;
  const list = channels();
  const i = list.findIndex((s) => chanKeyOf(s) === r.chan);
  if (i < 0) { log('⏰ stanice už není v seznamu: ' + r.title); renderAll(); return; }
  selIdx = i;
  renderAll();
  try { await applySelection(true); } catch {} // tiche: pri neuspechu drzi 'on' a zkousi watchdog
  toast('⏰ Přepínám na ' + list[i].name + ': ' + r.title, 8000);
  log('⏰ čas vypršel → přepínám na ' + list[i].name + ': ' + r.title);
  // Připnutý (seriál): hned naplánovat příští výskyt.
  if (wasPinned) planNext(key, { ...r, pinned: true });
}
function checkReminders() {
  const now = Date.now();
  let changed = false;
  for (const [k, r] of Object.entries(reminders)) {
    if (!r || !r.s) { delete reminders[k]; changed = true; continue; }
    if (r.e2 && r.e2 <= now) {
      if (r.pinned && (!r.retryAt || now >= r.retryAt)) {
        // Připnuté prošlé: zkusit automaticky přeplánovat (max 1× za hodinu).
        r.retryAt = now + 360e4;
        if (planNext(k, r)) changed = true;
        else persistSoon();
      } else if (!r.pinned) { delete reminders[k]; changed = true; }
      continue;
    }
    if (r.s <= now && (!r.e2 || now < r.e2)) {
      if (r.pinned) {
        // Pripnuto: hrat jen kdyz bezi jiny stream; jinak jen preplanovat (zustava v planu).
        const playing = video.classList.contains('on') && !paused && !video.paused && !video.ended;
        if (playing) fireReminder(k, r).catch(() => {});
        else planNext(k, { ...r, pinned: true });
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
  const all = channels().filter((st) => !st.opId);
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
document.getElementById('wClose').onclick = (e) => { e.stopPropagation(); if (invoke) invoke('win_close').catch(() => {}); };
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
  const panelW = document.getElementById('panelR').offsetWidth || 350;
  pop.style.left = Math.max(8, window.innerWidth - panelW - 10 - 300) + 'px';
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
  else if (e.key === 'Escape') { cancelBottomClose(); document.body.classList.remove('rightOpen', 'leftOpen', 'bottomOpen'); hideEpgPop(); hideProgDetail(); closeLoginModal(); }
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
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

// ---------- CRT sum ----------
const nctx = noiseCanvas.getContext('2d');
let noiseOn = true;
function sizeNoise() {
  // Pevne rozliseni sumu skalu CSS: pri resize okna se canvas nemaze,
  // takze neproblikne pozadi (vzdy video nebo static).
  noiseCanvas.width = 480;
  noiseCanvas.height = 270;
}
function drawNoise() {
  if (!noiseOn) return;
  const w = noiseCanvas.width, h = noiseCanvas.height;
  const img = nctx.createImageData(w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = (Math.random() * 255) | 0;
    d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
  }
  nctx.putImageData(img, 0, 0);
}
setInterval(() => { if (noiseOn && !document.hidden) drawNoise(); }, 90);
// Hum bary: nahodne kazdych 4-15 s se objevi 0-2 pasy putujici zdola nahoru (jen pres sum).
function humShow(el) {
  const dur = 6000 + Math.random() * 4000;
  el.style.display = 'block';
  const a = el.animate(
    [{ transform: 'translateY(105vh)' }, { transform: 'translateY(-160px)' }],
    { duration: dur, easing: 'linear' });
  a.onfinish = () => { el.style.display = 'none'; };
}
function humSchedule() {
  setTimeout(() => {
    if (noiseOn && !document.hidden) {
      const r = Math.random();
      const n = r < 0.25 ? 0 : (r < 0.65 ? 1 : 2);
      const bars = [document.getElementById('humbar1'), document.getElementById('humbar2')];
      for (let i = 0; i < n; i++) {
        const el = bars[i];
        if (el) setTimeout(() => { if (noiseOn) humShow(el); }, i * 2500);
      }
    }
    humSchedule();
  }, 4000 + Math.random() * 11000);
}
humSchedule();
// Detekce probuzeni ze sleepu: casovy skok od posledniho tiku (+navrat site) spusti celkovou obnovu.
let lastTick = Date.now(), recovering = false;
async function wakeRecovery(reason) {
  if (recovering || document.hidden || (!authMeta.sltv && !authMeta.oneplay)) return;
  recovering = true;
  diag('wakeRecovery(' + reason + ') start, online=' + navigator.onLine);
  try {
    log('probuzení (' + reason + ') — obnovuji…');
    const jobs = [];
    if (authMeta.sltv && !authMeta.sltv.manual) jobs.push((async () => {
      try {
        const l = await withConnecting('sltv', sltvLoadChannels);
        if (l.length) { liveChannels.sltv = l; log('SledováníTV: kanály dohrány po probuzení'); }
      } catch (e) { log('obnova po probuzení (sltv): ' + (e?.message || e)); }
    })());
    if (authMeta.oneplay && authMeta.oneplay.logged) jobs.push((async () => {
      try { await withConnecting('oneplay', () => oneplayEnsureEpg(true)); } catch (e) { log('obnova po probuzení (oneplay): ' + (e?.message || e)); }
    })());
    await Promise.all(jobs);
    persistCache(); renderAll();
    // Mrtvy stream po spanku: tichy reload (drzi 'on' pro watchdog — hlasity applySelection
    // by pri nedostupne siti zavolal renderIdle a uz by to nikdo nikdy nezkusil znovu).
    const st = currentStation();
    diag('wakeRecovery: jobs hotovy, st=' + (st ? st.name : '-') + ' paused=' + paused);
    if (st && !paused && (st.streamUrl || st.opId)) {
      await reloadQuiet();
      diag('wakeRecovery: reloadQuiet hotov');
      log('stream po probuzení předán watchdogu');
    }
  } finally { recovering = false; }
}
document.addEventListener('visibilitychange', () => {
  diag('visibility: ' + document.visibilityState + ' gap=' + Math.round((Date.now() - lastTick) / 1000) + 's');
  if (document.visibilityState !== 'hidden' && Date.now() - lastTick > 3 * 60e3) wakeRecovery('sleep');
});
window.addEventListener('online', () => { diag('online event'); wakeRecovery('online'); });
window.addEventListener('offline', () => { diag('offline event'); });
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
        if (url && paused && !video.src) { video.src = url; noiseOn = false; syncStageVideo(); renderStage(); log('obraz připraven (pauza, dodatečně)'); }
      }).catch(() => {});
    }
  }
  // Propadle Oneplay EPG dotahnout hned (necekat na 15min timer).
  if (!opEpgFresh()) oneplayEnsureEpg().then((n) => { if (n > 0) { persistCache(); renderAll(); } }).catch(() => {});
  renderStations(); renderStage();
}, 60000);
setInterval(async () => {
  if (document.hidden) return;
  if (curSrc === 'sltv' && authMeta.sltv && !authMeta.sltv.manual) {
    try {
      const list = await sltvLoadChannels();
      if (list.length) { liveChannels.sltv = list; persistCache(); renderAll(); log('EPG obnoveno (timer)'); }
    } catch (e) { log('EPG timer selhal: ' + (e?.message || e)); }
  }
  if (authMeta.oneplay && authMeta.oneplay.logged) {
    try {
      const n = await oneplayEnsureEpg(true);
      if (n > 0) { renderAll(); log('Oneplay EPG obnoveno (timer)'); }
    } catch (e) { log('Oneplay EPG timer selhal: ' + (e?.message || e)); }
  }
}, 15 * 60 * 1000);
// Pri resize ihned prekreslit: operacni system ukazuje nove odkrytou plochu
// okna driv, nez WebView stihne prekreslit — okamzity redraw zkracuje cerny zablesk.
window.addEventListener('resize', () => { sizeNoise(); drawNoise(); });

// ---------- video engine ----------
function stopStream() {
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
  stage.classList.toggle('hasvideo', video.classList.contains('on'));
  if (video.classList.contains('on')) {
    for (const id of ['humbar1', 'humbar2']) {
      const el = document.getElementById(id);
      if (el) { try { el.getAnimations().forEach((a) => a.cancel()); } catch {} el.style.display = 'none'; }
    }
  }
}
async function playStation(st, quiet = true) {
  stopStream();
  if (!st?.streamUrl) { if (!quiet) renderIdle(); else { video.classList.add('on'); syncStageVideo(); } return; }
  const url = st.streamUrl;
  try {
    if (st.drm && window.dashjs) {
      dashPlayer = dashjs.MediaPlayer().create();
      dashPlayer.setProtectionData({ 'com.widevine.alpha': { serverURL: st.drm.licenceUrl } });
      dashPlayer.initialize(video, url, !paused);
      log('DASH+Widevine → ' + st.name);
    } else if (/\.mpd(\?|$)/i.test(url) && window.dashjs) {
      dashPlayer = dashjs.MediaPlayer().create();
      dashPlayer.initialize(video, url, !paused);
      log('DASH → ' + st.name);
    } else if (window.Hls && Hls.isSupported() && /\.m3u8(\?|$)/i.test(url)) {
      hls = new Hls({ enableWorker: true });
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data?.fatal) return;
        log('HLS chyba: ' + (data.details || 'fatal'));
        if (quiet) { video.classList.add('on'); syncStageVideo(); } // drzet pro watchdog retry
        else { toast('Stream se nepodařilo přehrát (' + (data.details || 'chyba') + ').'); renderIdle(); }
      });
      if (!paused) video.play().catch(() => { paused = true; renderStage(); });
      log('HLS → ' + st.name);
    } else {
      video.src = url;
      if (!paused) await video.play().catch(() => { paused = true; renderStage(); });
      log('nativní video → ' + st.name);
    }
    everPlayed = true;
    noiseOn = false;
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
  noiseOn = true;
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
function renderBottomBar(st) {
  if (!st) { cancelBottomClose(); document.body.classList.remove('bottomOpen'); return; }
  const rows = epgRowsFor(st) || [];
  const nowMs = Date.now();
  const p = rows.find((r) => r.s && r.s <= nowMs && nowMs <= r.e2) || null;
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
  $('#nbTime').textContent = p && p.t ? (p.t + (p.e ? ' – ' + p.e : '')) : '';
  $('#nbTitle').textContent = title;
  const bar = $('#nbBar');
  if (pct !== null) { bar.style.display = ''; $('#nbBarFill').style.width = pct + '%'; }
  else bar.style.display = 'none';
  $('#nbDesc').textContent = (p && p.desc) || 'Bez popisu.';
}
function updateBottomClock() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const c = document.getElementById('nbClockTab');
  if (c) c.textContent = pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
}
updateBottomClock();
setInterval(() => { if (!document.hidden) updateBottomClock(); }, 1000);
let epgFilter = '';
function syncEpgFilterClear() {
  const fi = document.getElementById('epgFilter'), b = document.getElementById('epgFilterClear');
  if (fi && b) b.classList.toggle('on', !!fi.value);
}
function renderEpg(st) {
  hideProgDetail();
  if (renderEpg._for !== st.name) { epgFilter = ''; const fi = document.getElementById('epgFilter'); if (fi) fi.value = ''; syncEpgFilterClear(); }
  renderEpg._for = st.name;
  const e = $('#epg'); e.innerHTML = '';
  const live = epgRowsFor(st);
  const rows = live || (st.epg || []).map((p) => ({ t: p.t !== undefined ? p.t : p[0], title: p.title !== undefined ? p.title : p[1], now: !!(p.now !== undefined ? p.now : p[2]), pct: p.pct !== undefined ? p.pct : (p[3] || 10) }));
  if (!rows.length) { e.innerHTML = '<div class="emptyNote">K této stanici není program.</div>'; return; }
  const nowMs = Date.now();
  const q = normName(epgFilter);
  let lastDay = null;
  let shown = 0;
  const vis = rows.filter((p) => !q || normName(p.title).includes(q));
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
    const pctLive = p.s && p.e2 > p.s ? Math.max(0, Math.min(100, Math.round(((nowMs - p.s) / (p.e2 - p.s)) * 100))) : null;
    const d = document.createElement('div');
    d.className = 'ep' + (isNow ? ' now' : '');
    // Bez nativniho title tooltipu — popis ukazuje plovouci detail.
    const marked = !!reminders[remKey(curSrc, st, p)];
    // Zvonecek jen u poradu, ktere jeste nezacaly (bezici/minule naplanovat nejde).
    const upcoming = p.s && p.s > nowMs;
    d.innerHTML = '<span class="t">' + p.t + '</span><span class="ti">' + p.title + (isNow ? '<span class="live">LIVE</span>' : '') + '</span>'
      + (upcoming ? '<span class="rem' + (marked ? ' on' : '') + '" title="Připomenout a v daný čas přepnout">⏰</span>' : '')
      + (isNow && pctLive !== null ? '<div class="epProg"><div style="width:' + pctLive + '%"></div></div>' : '');
    if (upcoming) d.querySelector('.rem').onclick = (ev) => { ev.stopPropagation(); toggleReminder(st, p); };
    d.onclick = (ev) => {
      ev.stopPropagation();
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
  if (!shown && rows.length) e.innerHTML = '<div class="emptyNote">Nic neodpovídá filtru.</div>';
}
document.addEventListener('input', (e) => {
  if (e.target && e.target.id === 'epgFilter') {
    epgFilter = e.target.value; syncEpgFilterClear();
    const st = currentStation(); if (st) renderEpg(st);
  }
});
function renderSources() {
  const w = $('#sources'); w.innerHTML = '';
  SOURCES.forEach((s) => {
    const a = authMeta[s.id];
    const n = (liveChannels[s.id] || []).length;
    const card = document.createElement('div');
    card.className = 'srcCard' + (s.id === curSrc ? ' active' : '');
    const tip = s.name + (a ? (' · ' + (a.profileName || (n ? n + ' stanic' : 'přihlášeno'))) : ' · nepřihlášeno');
    card.innerHTML =
      '<div class="srcTop"><div class="srcLogo plain" title="' + tip + '"><img src="' + s.logo + '" alt="' + s.name + '"></div></div>' +
      (connecting[s.id]
        ? '<div class="srcBtns"><div class="connNote">Připojuji…</div></div>'
        : '<div class="srcBtns"><button class="btn ' + (a ? '' : 'primary') + '">' + (a ? 'Odhlásit' : 'Přihlásit') + '</button></div>');
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
    if (st.logo) { d.style.background = '#fff'; d.innerHTML = '<img src="' + st.logo + '" alt="' + st.name + '">'; }
    else { d.textContent = st.ini; d.style.background = st.color; }
    d.title = st.name + ' (podrž a táhni pro přeskládání)';
    d.addEventListener('pointerdown', (e) => favDragStart(e, d, favKey(st)));
    d.onmouseenter = () => scheduleEpgPop(d, st);
    d.onmouseleave = () => hideEpgPopSoon();
    d.onclick = (ev) => {
      if (suppressClick) { suppressClick = false; return; }
      ev.stopPropagation();
      const i = channels().findIndex((s) => s.name === st.name);
      if (i >= 0) {
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
function stIcon(st) {
  if (st.logo) return '<div class="stIco wide"><img src="' + st.logo + '" alt="' + st.name + '"></div>';
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
    r.querySelector('.star').onclick = (ev) => {
      ev.stopPropagation();
      favToggle(st);
      renderFavs(); renderStations();
      log((fav ? '☆ odebráno z oblíbených: ' : '★ oblíbená: ') + st.name);
    };
    r.onmouseenter = () => scheduleEpgPop(r, st);
    r.onmouseleave = () => hideEpgPopSoon();
    r.onclick = () => {
      if (i === selIdx && video.classList.contains('on')) {
        if (paused) { paused = false; resumeLive(); stage.classList.remove('paused'); persistSoon(); log('▶ přehrávání'); }
        return; // jiz hraje, nic neprepinat
      }
      selIdx = i; applySelection(false); log('stanice → ' + st.name + ' („' + st.now + '“)');
    };
    w.appendChild(r);
  });
}
function renderAll() { renderSources(); renderFavs(); renderReminders(); renderStations(); renderStage(); updatePin(); }
const CZ_MONTHS = ['led', 'úno', 'bře', 'dub', 'kvě', 'čen', 'čec', 'srp', 'zář', 'říj', 'lis', 'pro'];
function shortDate(ms) {
  const d = new Date(ms);
  return d.getDate() + '. ' + CZ_MONTHS[d.getMonth()];
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
function epgAvailable() {
  return Object.keys(epgBySrc.sltv).length > 0 || Object.keys(epgBySrc.oneplay).length > 0;
}
function planNext(key, r) {
  const p = findNextOccurrence(r);
  if (!p) {
    if (!epgAvailable()) {
      r.retryAt = Date.now() + 360e4; persistSoon();
      log('⏰ EPG nedostupné — zkusím přeplánovat později: ' + r.title);
      return false;
    }
    r.failed = true; delete r.retryAt; persistSoon(); renderReminders();
    const cur = currentStation(); if (cur) renderEpg(cur);
    log('⏰ pokračování nenalezeno: ' + r.title);
    return false;
  }
  delete r.failed; delete r.retryAt;
  delete reminders[key];
  const nk = r.src + '|' + r.chan + '|' + (p.id || ('s' + p.s));
  reminders[nk] = { src: r.src, chan: r.chan, id: p.id || ('s' + p.s), title: p.title, t: p.t, s: p.s, e2: p.e2, pinned: true, failed: false };
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
  const keys = Object.keys(reminders).sort((a, b) => (reminders[a].s || 0) - (reminders[b].s || 0));
  const show = keys.length > 0;
  w.style.display = show ? '' : 'none';
  if (hr) hr.style.display = show ? '' : 'none';
  if (!show) return;
  w.innerHTML = '';
  const todayStr = new Date().toDateString();
  keys.forEach((k) => {
    const r = reminders[k];
    const old = r.e2 && r.e2 <= Date.now();
    const stName = (() => {
      for (const src of ['sltv', 'oneplay']) {
        const f = (liveChannels[src] || []).find((s) => chanKeyOf(s) === r.chan);
        if (f) return f.name;
      }
      return r.title;
    })();
    const dateHtml = (r.s && new Date(r.s).toDateString() !== todayStr) ? '<small>' + shortDate(r.s) + '</small>' : '';
    const d = document.createElement('div');
    d.className = 'remRow' + (old ? ' old' : '');
    if (r.failed) d.className += ' failed';
    d.innerHTML = '<span class="t">' + (r.t || '') + dateHtml + '</span><span class="ti">' + r.title + '<small>' + stName + '</small></span>'
      + (r.failed ? '<span class="rr" title="Zkusit naplánovat znovu ručně">↻</span>' : '')
      + '<span class="rp' + (r.pinned ? ' on' : '') + '" title="Připnout automatické plánování">📌</span>'
      + '<span class="rx" title="Zrušit připomínku">×</span>';
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
    if (st.opId) st.streamUrl = null; // op URL po vypadku expirovana → dohledat znovu v applySelection
    else await fetchStreamUrl(st); // sltv manifesty expiruji: cerstve URL z playlistu
    await applySelection(true);
  } catch {}
}
/* QUIET JE DEFAULT: automaticke prehrani (boot, probuzeni, pripominka, watchdog) nesmi nikdy
   volat renderIdle ani toast — jinak by shodilo priznak 'on' a uz by to nikdo nezkusil znovu.
   Hlasite (false) jen po prime akci uzivatele (klik/klavesa/login). */
async function applySelection(quiet = true) {
  paused = false;
  const st = currentStation();
  if (st) selBySrc[curSrc] = st.name;
  renderFavs(); renderStations(); renderStage();
  if (!st) { wantPlay = false; renderIdle(); persistSoon(); return; }
  if (st.locked) {
    toast(st.noAccess ? 'Stanice není ve vašem balíčku.' : 'Stanice je uzamčena (rodičovský zámek).', 6000);
    log('zamčená stanice: ' + st.name);
    return;
  }
  if (!st.streamUrl && st.opId) {
    try {
      const tok = await oneplayToken();
      const m = await oneplayPlayUrl(tok, st.opId);
      const url = m.hls || m.dash || m.dashDrm;
      if (!url) throw new Error('Žádný přehratelný stream (možná DRM).');
      st.streamUrl = url;
      if (m.dashDrm && !m.hls) st.drm = m.drm;
      persistCache();
      renderStations(); renderStage();
    } catch (e) {
      if (!quiet) toast('Stream se nepodařilo načíst: ' + (e?.message || e));
      log('oneplay play: ' + (e?.message || e));
      return;
    }
  }
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
  // Jen sltv klice ('op:' patri Oneplay a zustavaji).
  if (id === 'sltv') epgBySrc.sltv = {};
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
function togglePause() {
  if (!currentStation() && !video.classList.contains('on')) return;
  paused = !paused;
  if (video.classList.contains('on')) { if (paused) { wantPlay = false; video.pause(); } else resumeLive(); }
  stage.classList.toggle('paused', paused && video.classList.contains('on'));
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
function hideProgDetail() {
  clearTimeout(progDetailT); progDetailT = null;
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
  document.getElementById('pdTitle').textContent = p.title;
  const srcName = (SOURCES.find((s) => s.id === curSrc) || {}).name || curSrc;
  document.getElementById('pdMeta').textContent = st.name + ' · ' + srcName;
  document.getElementById('pdTime').innerHTML = p.t + (p.e ? ' – ' + p.e : '') + (isNow ? '<span class="live">ŽIVĚ</span>' : '');
  const bar = document.getElementById('pdBar');
  if (isNow && pct !== null) { bar.style.display = ''; document.getElementById('pdBarFill').style.width = pct + '%'; }
  else bar.style.display = 'none';
  document.getElementById('pdDesc').textContent = p.desc || 'Bez popisu.';
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
let bottomHideT = null;
function scheduleBottomClose() {
  if (bottomHideT) return;
  bottomHideT = setTimeout(() => { bottomHideT = null; document.body.classList.remove('bottomOpen'); }, 350);
}
function cancelBottomClose() {
  if (bottomHideT) { clearTimeout(bottomHideT); bottomHideT = null; }
}
document.addEventListener('mousemove', (e) => {
  lastMX = e.clientX;
  if (e.clientX >= window.innerWidth - 24) { clearTimeout(hideT); document.body.classList.add('rightOpen'); }
  // Levy panel jen kdyz je pro stanici program — bez dat se vubec neotevira.
  else if (e.clientX <= 24 && currentStation() && epgRowsFor(currentStation()).length) { clearTimeout(hideT); document.body.classList.add('leftOpen'); }
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
(function () {
  const savedR = +(localStorage.getItem('tvklient.panelW_R') || 0);
  const savedL = +(localStorage.getItem('tvklient.panelW_L') || 0);
  window.__panelW = { R: savedR, L: savedL };
  function applyW() {
    if (window.__panelW.R > 0) $('#panelR').style.width = window.__panelW.R + 'px';
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
        p.style.width = Math.max(220, Math.min(620, wpx)) + 'px';
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
  epgFilter = ''; if (fi) { fi.value = ''; fi.focus(); } syncEpgFilterClear();
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
    const upcoming = p.s && p.s > nowMs;
    d.innerHTML = '<span class="t">' + (p.t || '') + '</span><span class="ti">' + p.title + (p.now ? '<span class="live">LIVE</span>' : '') + '</span>'
      + (upcoming ? '<span class="rem' + (marked ? ' on' : '') + '" title="Připomenout a v daný čas přepnout">⏰</span>' : '')
      + (p.now && p.pct !== null ? '<div class="epProg"><div style="width:' + p.pct + '%"></div></div>' : '');
    if (upcoming) d.querySelector('.rem').onclick = (ev) => {
      ev.stopPropagation();
      toggleReminder(st, p);
      ev.target.classList.toggle('on', !!reminders[remKey(curSrc, st, p)]);
    };
    list.appendChild(d);
  });
  pop.classList.add('on');
  const panelW = document.getElementById('panelR').offsetWidth || 350;
  pop.style.left = Math.max(8, window.innerWidth - panelW - 10 - 270) + 'px';
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
    favBySrc[curSrc] = [...$('#favs').querySelectorAll('.fav')].map((el) => el.dataset.key);
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
async function sltvLoadEpg() {
  // Program na ~4 dny dopredu (4 okna po 1439 minutach), deduplikace pres eventId.
  const out = {};
  const seen = {};
  const p = (n) => String(n).padStart(2, '0');
  for (let d = 0; d < 4; d++) {
    const base = new Date(Date.now() + d * 1440 * 60000);
    const tstr = base.getFullYear() + '-' + p(base.getMonth() + 1) + '-' + p(base.getDate()) + ' ' + p(base.getHours()) + ':' + p(base.getMinutes()) + ':00';
    let j;
    try { j = JSON.parse(await sltvGet('/api/epg?detail=description&duration=1439&time=' + encodeURIComponent(tstr))); }
    catch (e) { log('EPG den +' + d + ' selhal: ' + (e?.message || e)); break; }
    for (const [ch, events] of Object.entries(j.channels || {})) {
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
          t: String(ev.startTime || '').slice(11, 16), e: String(ev.endTime || '').slice(11, 16),
          title: ev.title || '?', desc: (ev.description || '').slice(0, 500), img: null, // sltv v EPG obrazek nedava
          s, e2, day: new Date(s).toDateString(),
        });
      }
    }
  }
  for (const ch of Object.keys(out)) out[ch].sort((a, b) => a.s - b.s);
  return out;
}
const CZ_DAYS = ['Neděle', 'Pondělí', 'Úterý', 'Středa', 'Čtvrtek', 'Pátek', 'Sobota'];
function dayLabel(ms) {
  const d = new Date(ms), now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const tag = d.toDateString() === now.toDateString() ? ' · dnes'
    : new Date(now.getTime() + 86400000).toDateString() === d.toDateString() ? ' · zítra' : '';
  return CZ_DAYS[d.getDay()] + ' ' + d.getDate() + '. ' + (d.getMonth() + 1) + '.' + tag;
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
  try {
    epgBySrc.sltv = await sltvLoadEpg();
    log('EPG nacteno pro ' + Object.keys(epgBySrc.sltv).length + ' klicu');
    logEpgCoverage();
  } catch (e) { log('EPG: ' + e); }
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
  const data = await opCall('epg.display', { payload: { criteria: { channelSetId: 'channel_list.1', viewport: { channelRange: { from: 0, to: 200 }, timeRange: { from: iso(nowMs - 2 * 360e4), to: iso(nowMs + 24 * 360e4) }, schema: 'EpgViewportAbsolute' } }, requestedOutput: { channelList: 'none', datePicker: false, channelSets: false } } }, token);
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
  return { hls, dash, dashDrm, drm };
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
  try {
    const list = await oneplayChannels(token, pid);
    if (list.length) { liveChannels.oneplay = list; log('Oneplay: kanály obnoveny (' + list.length + ')'); }
  } catch (e) { log('Oneplay: kanály se nepodařilo obnovit: ' + (e?.message || e)); }
  oneplayEnsureEpg().then((n) => { if (n > 0) renderAll(); }).catch(() => {});
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

// ---------- modalni prihlaseni: jmeno+heslo -> (profily) -> zpet ----------
// SledovaniTV profily nema (jde rovnou), Oneplay ukaze serverove profily.
let loginFor = null;
let connecting = { sltv: false, oneplay: false };
async function withConnecting(id, fn) {
  connecting[id] = true; renderSources();
  try { return await fn(); }
  finally { connecting[id] = false; renderSources(); }
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
    : 'Zadej e-mail / O2 ID a heslo <b>jednou</b>. Pak vybereš profil; dál je vše automatické.';
  document.getElementById('loginErr').classList.remove('on');
  $('#loginPass').value = '';
  loginModal().classList.add('on');
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
    favBySrc: { sltv: [...(favBySrc.sltv || [])], oneplay: [...(favBySrc.oneplay || [])] },
    srcCollapsed: srcCollapsed === true,
    vol: Math.max(0, Math.min(100, Math.round(appVol))),
    muted: appMuted === true,
    reminders: { ...reminders },
    everPlayed: everPlayed === true,
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
    eid: st.eid || null, opId: st.opId || null, name: st.name, ini: st.ini, color: st.color,
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
  persistSoon(); // prepsat pripadne poskozeny soubor cistymi hodnotami
  authMeta = await storeGet('authMeta');
  if (!authMeta || typeof authMeta !== 'object' || Array.isArray(authMeta)) authMeta = { sltv: null, oneplay: null };
  else {
    for (const k of ['sltv', 'oneplay']) {
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
  stripVolatileEpgs(liveChannels.sltv); stripVolatileEpgs(liveChannels.oneplay);
  // Stara cache mela Oneplay loga v osekavajicim ctverci 256x256 — prepsat na siroky rozmer.
  for (const s of liveChannels.oneplay) {
    if (s && typeof s.logo === 'string' && s.logo.includes('r256x256n')) s.logo = s.logo.replace('r256x256n', 'r320x196n');
  }
  // Oblibene: novy per-source format, jinak migrace ze stareho pole jmen (prejmenovani stanic).
  favBySrc = { sltv: [], oneplay: [] };
  const storedFavs = await storeGet('favBySrc');
  const validFavs = storedFavs && typeof storedFavs === 'object' && ['sltv', 'oneplay'].every((s) => Array.isArray(storedFavs[s]) && storedFavs[s].every((x) => typeof x === 'string'));
  if (validFavs) {
    favBySrc = { sltv: [...storedFavs.sltv], oneplay: [...storedFavs.oneplay] };
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
    if (!st || (!st.streamUrl && !st.opId)) return;
    // Pauza: nic nepoustet ani nemazat — obraz pripravi finalni boot blok (jinak by zustal sum).
    if (paused) return;
    autoplayed = true;
    try { await applySelection(true); } catch {}
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
    // Cache neuklada stream URL — pro zapamatovanou stanici dotahnout cerstve kanaly (stary token si opCall sam obnovi).
    if (authMeta.oneplay && authMeta.oneplay.logged && liveChannels.oneplay.length && !liveChannels.oneplay.some((s) => s.streamUrl)) {
      try {
        const t = await vaultGet('oneplay.token');
        const pid = authMeta.oneplay.profileId || await vaultGet('oneplay.profileId');
        if (t && pid) {
          const fresh = await withConnecting('oneplay', () => oneplayChannels(t, pid));
          if (fresh.length) { liveChannels.oneplay = fresh; persistCache(); log('Oneplay: kanály dohrány pro autoplay'); }
        }
      } catch (e) { log('Oneplay: čerstvé kanály selhaly: ' + (e?.message || e)); }
    }
    // EPG se pri startu vzdy cerstve dotahne s viditelnym stavem (duvod videt "Pripojuji…" i u Oneplay).
    if (authMeta.oneplay && authMeta.oneplay.logged) {
      try {
        const n = await withConnecting('oneplay', () => oneplayEnsureEpg(true));
        if (n > 0) { persistCache(); renderAll(); }
      } catch (e) { log('Oneplay EPG: ' + (e?.message || e)); }
    }
    maybeAutoplay('oneplay').catch(() => {});
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
  await Promise.all([bootSltv(), bootOneplay()]);
  persistCache();
  await storeSet('authMeta', authMeta);
  renderAll();
  // Po startu nezustava pripnuty panel, pokud na nem neni mys (updatePin ho pripnul pred nactenim stanic).
  if (currentStation()) {
    if (lastMX < window.innerWidth - 24) document.body.classList.remove('rightOpen');
    if (lastMX > 24) document.body.classList.remove('leftOpen');
  }
  // Autoplay: Oneplay URL se dohledava az pri prehrani (applySelection), staci opId.
  // Bez rucni zmeny behem bootu (jinak plati volba uzivatele, maybeAutoplay uz hral nebo hraje).
  const st = currentStation();
  const untouched = !autoplayed && selIdx === bootSelIdx && curSrc === bootSrc;
  if (untouched && st && (st.streamUrl || st.opId) && !paused) applySelection(true); // tiche: watchdog to pri neuspechu zkusi znovu
  else if (untouched && st?.streamUrl && paused) { video.src = st.streamUrl; video.classList.add('on'); noiseOn = false; syncStageVideo(); renderStage(); }
  else if (untouched && paused && st && !st.streamUrl && ((st.opId && authMeta.oneplay && authMeta.oneplay.logged) || (st.eid && authMeta.sltv && !authMeta.sltv.manual))) {
    // Pauza bez URL (cache): dohledat URL a pripravit zmrazeny obraz, nehrat. Oba zdroje stejne.
    video.classList.add('on'); syncStageVideo(); renderStage();
    (async () => {
      const url = await fetchStreamUrl(st);
      if (url) { video.src = url; noiseOn = false; syncStageVideo(); renderStage(); log('obraz připraven (pauza)'); }
      else log('obraz v pauze se nepodařilo připravit');
    })().catch(() => {});
  }
  
  else if (!autoplayed) { wantPlay = false; renderIdle(); }

  if (!authMeta.sltv && !authMeta.oneplay) {
    log('zadne uložené přihlášení — vyber si zdroj a klikni Přihlásit');
  }
}

window.addEventListener('resize', () => { sizeNoise(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persistNow().catch(() => {}); });
window.addEventListener('beforeunload', () => { try { persistNow(); } catch {} storeFlush(); });

sizeNoise();
restoreWinGeometry().then(() => winInfoExfil()).catch(() => {});
watchWinState();
renderAll(); // okamzity prvni render: zadne prazdne sekce pred siti
winInfoExfil();
restore().then(() => {
  log('tv-client spuštěn · zdroj ' + srcOf().name + (currentStation() ? '' : ' · bez přihlášení'));
});
