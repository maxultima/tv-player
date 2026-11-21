// Internationalization (i18n): English (default) and Czech.
const DICT = {
  en: {
    // Basic settings & right panel
    cfgGenHead: '⚙ Basic Settings',
    langLabel: 'Language:',
    autostart: 'Launch at startup',
    autostartTitle: 'Automatically launch the app after signing in to Windows',
    cfgRecHead: 'Recording',
    recFormat: 'Format:',
    recFormatTs: 'TS (original, no transcoding)',
    recPad: 'Post-padding:',
    recDir: 'Folder:',
    recDirBtnTitle: 'Choose folder',
    recFmt: 'Filename:',
    recPrev: 'Preview: ',
    stationFilter: 'Search station…',
    epgFilter: 'Search program…',
    clearText: 'Clear text',
    login: 'Sign in',
    logout: 'Sign out',
    connecting: 'Connecting…',
    notSignedIn: 'not signed in',
    signedIn: 'signed in',
    stationsCount: '{n} stations',
    // Top filters panel
    fltTitle: '✨ Video Filters',
    presetDefault: 'Default',
    presetCinema: 'Cinema',
    presetVivid: 'Sports / Live',
    presetNight: 'Night',
    fltReset: '↺ Reset',
    fltBright: 'Brightness',
    fltCont: 'Contrast',
    fltSat: 'Saturation',
    fltWarm: 'Warmth',
    fltCas: 'Sharpening (CAS):',
    fltUp: 'Upscaling (GPU shader):',
    off: 'Off',
    subtle: 'Subtle',
    strong: 'Strong',
    on: 'On',
    // Bottom bar & EPG
    live: 'LIVE',
    timeshift: 'ARCHIVE',
    noDesc: 'No description.',
    noEpg: 'No program guide for this station.',
    noFilterMatch: 'Nothing matches the filter.',
    btnFromStart: 'Play program from start',
    btnLive: 'Switch to live',
    btnRecStart: 'Record program from start',
    btnRec: 'Record running program',
    btnStopRec: 'Stop recording',
    today: 'TODAY',
    tomorrow: 'TOMORROW',
    days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    daysUpper: ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'],
    // Recording & archive download
    hideStream: '👁 Hide stream',
    showStream: '👁 Show stream',
    stopRecBtn: '⏹ Stop recording',
    streamHiddenSub: 'Stream hidden',
    recStopTitle: '⏹ Stop recording?',
    recStopText: 'Are you sure you want to stop the active recording? Recorded data will be saved.',
    recStopTextClose: 'Recording is in progress! Stop recording and close the app?',
    recStopRecorded: 'Recorded:',
    recStopFile: 'File:',
    btnContinue: 'Continue',
    btnDiscard: 'Discard',
    btnStopSave: 'Stop & save',
    recColTitle: '⚠ Scheduling collision',
    recColIntro: 'This program conflicts with another scheduled recording on the same source.',
    recColNew: 'New request:',
    recColList: 'Conflicts with:',
    btnCancel: 'Cancel',
    btnReplacePlan: 'Replace conflicting plan',
    btnReplaceActive: 'Stop active & replace',
    convMp4: 'converting to MP4…',
    waitingNet: 'waiting for network…',
    remEta: 'left ~',
    dlPastTip: 'Download from archive',
    dlAfterTip: 'Download from archive after broadcast ends (PC can sleep)',
    recNowTip: 'Record now',
    recPlanTip: 'Schedule recording',
    remTip: 'Remind and switch at start time',
    // Offline overlay
    netOfflineTitle: 'Network unavailable',
    netOfflineSub: 'Waiting for reconnection',
    netAttempt: 'Attempt #{n} · next in {s} s',
    netProbing: 'Attempt #{n} · checking network…',
    // Login modal
    loginTitle: 'Sign in',
    loginSub: 'Credentials are stored encrypted locally on this device.',
    loginUser: 'E-mail / login',
    loginPass: 'Password',
    whoWatches: 'Who is watching?',
    whoWatchesSub: 'Select the profile to stream with.',
    btnBack: 'Back',
    // Help popup
    helpPlayback: 'Playback & Window',
    helpPanels: 'Panels & Navigation',
    helpEpg: 'EPG & Reminders',
    helpRec: 'Recording & Archive',
    helpPause: 'Pause / resume',
    helpMax: 'Maximize / window',
    helpMove: 'Move window',
    helpClose: 'Close open panels',
    helpSwitch: 'Switch station',
    helpRight: 'Sources, favorites, stations',
    helpLeft: 'Program guide & search',
    helpTop: 'Video filters & GPU shaders',
    helpBottom: 'Current program & timeshift',
  },
  cs: {
    cfgGenHead: '⚙ Základní nastavení',
    langLabel: 'Jazyk:',
    autostart: 'Spustit při startu',
    autostartTitle: 'Automaticky spustit aplikaci po přihlášení do Windows',
    cfgRecHead: 'Nahrávání',
    recFormat: 'Formát:',
    recFormatTs: 'TS (originál, bez překódování)',
    recPad: 'Přesah po konci:',
    recDir: 'Složka:',
    recDirBtnTitle: 'Vybrat adresář',
    recFmt: 'Název:',
    recPrev: 'Náhled: ',
    stationFilter: 'Hledat stanici…',
    epgFilter: 'Hledat pořad…',
    clearText: 'Smazat text',
    login: 'Přihlásit',
    logout: 'Odhlásit',
    connecting: 'Připojuji…',
    notSignedIn: 'nepřihlášeno',
    signedIn: 'přihlášeno',
    stationsCount: '{n} stanic',
    fltTitle: '✨ Obrazové filtry',
    presetDefault: 'Výchozí',
    presetCinema: 'Kino',
    presetVivid: 'Sport / Živé',
    presetNight: 'Noční',
    fltReset: '↺ Reset',
    fltBright: 'Jas',
    fltCont: 'Kontrast',
    fltSat: 'Sytost',
    fltWarm: 'Teplota',
    fltCas: 'Doostření (CAS):',
    fltUp: 'Upscaling (GPU shader):',
    off: 'Vypnuto',
    subtle: 'Jemné',
    strong: 'Silné',
    on: 'Zapnuto',
    live: 'ŽIVĚ',
    timeshift: 'ZPĚTNĚ',
    noDesc: 'Bez popisu.',
    noEpg: 'K této stanici není program.',
    noFilterMatch: 'Nic neodpovídá filtru.',
    btnFromStart: 'Přehrát pořad od začátku',
    btnLive: 'Přehrávat živě',
    btnRecStart: 'Nahrát pořad od začátku',
    btnRec: 'Nahrávat běžící pořad',
    btnStopRec: 'Zastavit nahrávání',
    today: 'DNES',
    tomorrow: 'ZÍTRA',
    days: ['neděle', 'pondělí', 'úterý', 'středa', 'čtvrtek', 'pátek', 'sobota'],
    daysUpper: ['NEDĚLE', 'PONDĚLÍ', 'ÚTERÝ', 'STŘEDA', 'ČTVRTEK', 'PÁTEK', 'SOBOTA'],
    hideStream: '👁 Skrýt stream',
    showStream: '👁 Zobrazit stream',
    stopRecBtn: '⏹ Zastavit nahrávání',
    streamHiddenSub: 'Stream je skrytý',
    recStopTitle: '⏹ Zastavit nahrávání?',
    recStopText: 'Opravdu chceš ukončit probíhající nahrávání? Dosavadní záznam bude uložen.',
    recStopTextClose: 'Probíhá nahrávání! Opravdu chceš ukončit nahrávání a zavřít aplikaci?',
    recStopRecorded: 'Nahráno:',
    recStopFile: 'Soubor:',
    btnContinue: 'Pokračovat',
    btnDiscard: 'Zahodit',
    btnStopSave: 'Zastavit a uložit',
    recColTitle: '⚠ Kolize plánování',
    recColIntro: 'Pořad koliduje s jiným naplánovaným záznamem ze stejného zdroje.',
    recColNew: 'Nový požadavek:',
    recColList: 'Koliduje s:',
    btnCancel: 'Zrušit',
    btnReplacePlan: 'Nahradit kolidující plán',
    btnReplaceActive: 'Zastavit běžící a nahradit',
    convMp4: 'konverze do MP4…',
    waitingNet: 'čekám na síť…',
    remEta: 'zbývá ~',
    dlPastTip: 'Stáhnout z archivu',
    dlAfterTip: 'Stáhnout z archivu po skončení pořadu (PC může mezitím spát)',
    recNowTip: 'Nahrávat hned',
    recPlanTip: 'Naplánovat nahrávání',
    remTip: 'Připomenout a v daný čas přepnout',
    netOfflineTitle: 'Síť není dostupná',
    netOfflineSub: 'Čekám na obnovení připojení',
    netAttempt: 'Pokus č. {n} · další za {s} s',
    netProbing: 'Pokus č. {n} · ověřuji síť…',
    loginTitle: 'Přihlášení',
    loginSub: 'Údaje se uloží šifrovaně jen lokálně v tomto počítači.',
    loginUser: 'E-mail / login',
    loginPass: 'Heslo',
    whoWatches: 'Kdo sleduje?',
    whoWatchesSub: 'Vyber profil, který bude streamovat.',
    btnBack: 'Zpět',
    helpPlayback: 'Přehrávání a okno',
    helpPanels: 'Panely a navigace',
    helpEpg: 'EPG a připomínky',
    helpRec: 'Nahrávání a archiv',
    helpPause: 'Pauza / přehrát',
    helpMax: 'Maximalizace / okno',
    helpMove: 'Přesun okna',
    helpClose: 'Zavřít panely',
    helpSwitch: 'Přepnout stanici',
    helpRight: 'Zdroje, oblíbené, stanice',
    helpLeft: 'Program a vyhledávání',
    helpTop: 'Obrazové filtry a GPU shadery',
    helpBottom: 'Aktuální pořad a timeshift',
  },
};

let curLang = 'en';
try {
  const saved = localStorage.getItem('tv_lang');
  if (saved === 'en' || saved === 'cs') curLang = saved;
} catch {}

export function getLang() { return curLang; }

export function setLang(lang) {
  if (lang !== 'en' && lang !== 'cs') return;
  curLang = lang;
  try { localStorage.setItem('tv_lang', lang); } catch {}
  document.documentElement.lang = lang;
  applyI18n();
}

export function t(key, vars) {
  const d = DICT[curLang] || DICT.en;
  let val = d[key] !== undefined ? d[key] : (DICT.en[key] !== undefined ? DICT.en[key] : key);
  if (typeof val === 'string' && vars) {
    for (const [k, v] of Object.entries(vars)) val = val.replaceAll('{' + k + '}', String(v));
  }
  return val;
}

export function applyI18n() {
  const setText = (sel, key) => { const el = document.querySelector(sel); if (el) el.textContent = t(key); };
  const setPh = (sel, key) => { const el = document.querySelector(sel); if (el) el.placeholder = t(key); };
  const setTitle = (sel, key) => { const el = document.querySelector(sel); if (el) el.title = t(key); };

  // Basic settings
  setText('#genCfg .cfgHead', 'cfgGenHead');
  setText('#langRow label', 'langLabel');
  setText('#autostartRow span', 'autostart');
  setTitle('#autostartRow', 'autostartTitle');
  const langSel = document.getElementById('langSel');
  if (langSel) langSel.value = curLang;

  // Recording settings
  const recHead = document.querySelector('#recCfg .cfgHead');
  if (recHead) recHead.innerHTML = '<span style="color:var(--acc)">⏺</span> ' + t('cfgRecHead');
  setText('label[for="recCodec"]', 'recFormat');
  const tsOpt = document.querySelector('#recCodec option[value="ts"]');
  if (tsOpt) tsOpt.textContent = t('recFormatTs');
  setText('label[for="recPad"]', 'recPad');
  setText('label[for="recDir"]', 'recDir');
  setTitle('#btnRecDir', 'recDirBtnTitle');
  setText('label[for="recFmt"]', 'recFmt');

  // Filters & search
  setPh('#stationFilter', 'stationFilter');
  setTitle('#stationFilterClear', 'clearText');
  setPh('#epgFilter', 'epgFilter');
  setTitle('#epgFilterClear', 'clearText');

  // Top video filters panel
  setText('#panelT .ptTitle', 'fltTitle');
  setText('#ptPresets [data-preset="default"]', 'presetDefault');
  setText('#ptPresets [data-preset="cinema"]', 'presetCinema');
  setText('#ptPresets [data-preset="vivid"]', 'presetVivid');
  setText('#ptPresets [data-preset="night"]', 'presetNight');
  setText('#ptReset', 'fltReset');
  setText('label[for="fltBright"]', 'fltBright');
  setText('label[for="fltCont"]', 'fltCont');
  setText('label[for="fltSat"]', 'fltSat');
  setText('label[for="fltWarm"]', 'fltWarm');
  const ptGrps = document.querySelectorAll('#panelT .ptGrp > span');
  if (ptGrps[0]) ptGrps[0].textContent = t('fltCas');
  if (ptGrps[1]) ptGrps[1].textContent = t('fltUp');
  setText('[data-cas="0"]', 'off');
  setText('[data-cas="1"]', 'subtle');
  setText('[data-cas="2"]', 'strong');
  setText('[data-up="0"]', 'off');
  setText('[data-up="1"]', 'on');

  // Bottom bar buttons
  setTitle('#nbFromStartBtn', 'btnFromStart');
  setTitle('#nbLiveBtn', 'btnLive');
  setTitle('#nbRecStartBtn', 'btnRecStart');
  setTitle('#nbRecBtn', 'btnRec');
  setTitle('#nbStopRecBtn', 'btnStopRec');

  // Recording panel & modals
  setText('#btnRecStop', 'stopRecBtn');
  setText('#recCollisionModal h2', 'recColTitle');
  setText('#recColIntro', 'recColIntro');
  setText('#btnRecColCancel', 'btnCancel');
  setText('#recStopModal h2', 'recStopTitle');
  setText('#btnRecStopCancel', 'btnContinue');
  setText('#btnRecStopDiscard', 'btnDiscard');
  setText('#btnRecStopConfirm', 'btnStopSave');

  // Offline overlay
  setText('#offlineCard h3', 'netOfflineTitle');
  const offSub = document.querySelector('#offlineCard .offSub');
  if (offSub) offSub.innerHTML = t('netOfflineSub') + '<span class="offDots"><span>.</span><span>.</span><span>.</span></span>';

  // Login modal
  setPh('#loginUser', 'loginUser');
  setPh('#loginPass', 'loginPass');
  setText('#btnDoLogin', 'login');
  setText('#btnCloseLogin', 'btnCancel');
  setText('#btnCloseLogin2', 'btnCancel');
  setText('#btnBackToCreds', 'btnBack');
}
