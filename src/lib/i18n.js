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
    epgSearchOtherCh: 'Search other channels',
    epgSearchOtherSrc: 'Search other sources',
    epgWatchBtnTitle: 'Save search and notify when a matching program appears in EPG',
    epgWatchModalTitle: '🔔 Save EPG Watch',
    epgWatchModalSub: 'When a matching program appears in the guide, a notification will be shown.',
    epgWatchSave: 'Save watch',
    epgWatchQueryLbl: 'Search query:',
    epgWatchScopeLbl: 'Scan scope:',
    epgWatchScopeAll: 'all channels · all sources',
    epgWatchScopeSrc: 'all channels ({src})',
    epgWatchScopeStOtherSrc: '{st} + other sources',
    epgWatchScopeStOnly: '{st} only ({src})',
    epgWatchRowTip: 'Click to show current matches in EPG',
    epgWatchDelTip: 'Delete watch',
    epgNotifTag: '🔔 Watched program found in EPG',
    epgNotifFilter: 'filter “{q}”',
    epgNotifOpen: 'Show in EPG',
    epgNotifSwitch: '⏰ Switch to show',
    epgNotifSaveDl: '⬇ Schedule download',
    epgNotifSnooze: '🕒 Remind tomorrow',
    epgNotifWaitNext: '⏭ Wait for next',
    epgNotifDelete: '🗑 Delete',
    epgNotifDlUnavail: 'Archive download is not available for this channel',
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
    presetStandardEnhanced: 'Standard - Enhanced',
    presetCinema: 'Cinema',
    presetVivid: 'Sports / Live',
    presetNight: 'Night',
    fltReset: '↺ Reset',
    fltBright: 'Brightness',
    fltCont: 'Contrast',
    fltSat: 'Saturation',
    fltWarm: 'Warmth',
    fltTone: 'Tonal contrast',
    fltNoise: 'Halftone',
    fltGrain: 'Noise',
    fltVig: 'Vignette',
    fltCas: 'Sharpening (CAS):',
    fltUp: 'Upscaling (GPU shader):',
    fltAuto: 'Auto bright/contrast:',
    fltEyeTitle: 'Toggle all filters on/off (before/after)',
    profSelect: '— select profile —',
    profBuiltIn: 'Presets',
    profCustom: 'Custom profiles',
    profSaveTitle: '💾 Save filter profile',
    profSaveSub: 'Enter a name to save the current video filter settings.',
    profSavePh: 'Profile name…',
    profSaveBtn: 'Save',
    profDelTitle: '🗑 Delete filter profile?',
    profDelText: 'Are you sure you want to delete profile "{name}"?',
    profDelBtn: 'Delete',
    off: 'Off',
    subtle: 'Subtle',
    strong: 'Strong',
    on: 'On',
    // Bottom bar & EPG
    live: 'LIVE',
    timeshift: 'ARCHIVE',
    noDesc: 'No description.',
    noProgram: 'No program',
    noEpg: 'No program guide for this station.',
    noFilterMatch: 'Nothing matches the filter.',
    lockedPackage: 'Station is not in your subscription package.',
    lockedParental: 'Station is locked (parental lock).',
    streamLoadErr: 'Failed to load stream: ',
    favDragTip: 'hold and drag to reorder',
    months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
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
    epgSearchOtherCh: 'Prohledávat ostatní kanály',
    epgSearchOtherSrc: 'Prohledávat i ostatní zdroje',
    epgWatchBtnTitle: 'Uložit vyhledávání a upozornit, až se pořad objeví v EPG',
    epgWatchModalTitle: '🔔 Uložit hlídání v EPG',
    epgWatchModalSub: 'Jakmile se v programu objeví odpovídající pořad, aplikace zobrazí upozornění.',
    epgWatchSave: 'Uložit hlídání',
    epgWatchQueryLbl: 'Hledaný výraz:',
    epgWatchScopeLbl: 'Rozsah skenování:',
    epgWatchScopeAll: 'všechny kanály · všechny zdroje',
    epgWatchScopeSrc: 'všechny kanály ({src})',
    epgWatchScopeStOtherSrc: '{st} + ostatní zdroje',
    epgWatchScopeStOnly: 'jen {st} ({src})',
    epgWatchRowTip: 'Kliknutím zobrazíš aktuální shody v EPG',
    epgWatchDelTip: 'Smazat hlídání',
    epgNotifTag: '🔔 Nalezen hlídaný pořad v EPG',
    epgNotifFilter: 'filtr „{q}“',
    epgNotifOpen: 'Zobrazit v EPG',
    epgNotifSwitch: '⏰ Přepnout na pořad',
    epgNotifSaveDl: '⬇ Naplánovat uložení',
    epgNotifSnooze: '🕒 Připomenout zítra',
    epgNotifWaitNext: '⏭ Počkat na další',
    epgNotifDelete: '🗑 Odstranit',
    epgNotifDlUnavail: 'Uložení z archivu není u této stanice podporováno',
    clearText: 'Smazat text',
    login: 'Přihlásit',
    logout: 'Odhlásit',
    connecting: 'Připojuji…',
    notSignedIn: 'nepřihlášeno',
    signedIn: 'přihlášeno',
    stationsCount: '{n} stanic',
    fltTitle: '✨ Obrazové filtry',
    presetDefault: 'Výchozí',
    presetStandardEnhanced: 'Standard - vylepšeno',
    presetCinema: 'Kino',
    presetVivid: 'Sport / Živé',
    presetNight: 'Noční',
    fltReset: '↺ Reset',
    fltBright: 'Jas',
    fltCont: 'Kontrast',
    fltSat: 'Sytost',
    fltWarm: 'Teplota',
    fltTone: 'Tonální kontrast',
    fltNoise: 'Polotón',
    fltGrain: 'Šum',
    fltVig: 'Vinětace',
    fltCas: 'Doostření (CAS):',
    fltUp: 'Upscaling (GPU shader):',
    fltAuto: 'Auto jas/kontrast:',
    fltEyeTitle: 'Vypnout / zapnout všechny filtry (porovnání)',
    profSelect: '— vybrat profil —',
    profBuiltIn: 'Předvolby',
    profCustom: 'Vlastní profily',
    profSaveTitle: '💾 Uložit profil filtrů',
    profSaveSub: 'Zadej název pro uložení aktuálního nastavení obrazových filtrů.',
    profSavePh: 'Název profilu…',
    profSaveBtn: 'Uložit',
    profDelTitle: '🗑 Smazat profil filtrů?',
    profDelText: 'Opravdu chceš smazat profil „{name}“?',
    profDelBtn: 'Smazat',
    off: 'Vypnuto',
    subtle: 'Jemné',
    strong: 'Silné',
    on: 'Zapnuto',
    live: 'ŽIVĚ',
    timeshift: 'ZPĚTNĚ',
    noDesc: 'Bez popisu.',
    noProgram: 'Bez programu',
    noEpg: 'K této stanici není program.',
    noFilterMatch: 'Nic neodpovídá filtru.',
    lockedPackage: 'Stanice není ve vašem balíčku.',
    lockedParental: 'Stanice je uzamčena (rodičovský zámek).',
    streamLoadErr: 'Stream se nepodařilo načíst: ',
    favDragTip: 'podrž a táhni pro přeskládání',
    months: ['led', 'úno', 'bře', 'dub', 'kvě', 'čen', 'čec', 'srp', 'zář', 'říj', 'lis', 'pro'],
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
  setTitle('#btnEpgWatch', 'epgWatchBtnTitle');
  setText('#epgOptOtherChLbl', 'epgSearchOtherCh');
  setText('#epgOptOtherSrcLbl', 'epgSearchOtherSrc');
  setText('#wmTitle', 'epgWatchModalTitle');
  setText('#wmSub', 'epgWatchModalSub');
  setText('#wmOtherChLbl', 'epgSearchOtherCh');
  setText('#wmOtherSrcLbl', 'epgSearchOtherSrc');
  setText('#btnWmCancel', 'btnCancel');
  setText('#btnWmSave', 'epgWatchSave');

  // Top video filters panel
  setText('#panelT .ptTitle', 'fltTitle');
  setText('#ptReset', 'fltReset');
  setText('label[for="fltBright"]', 'fltBright');
  setText('label[for="fltCont"]', 'fltCont');
  setText('label[for="fltSat"]', 'fltSat');
  setText('label[for="fltWarm"]', 'fltWarm');
  setText('label[for="fltTone"]', 'fltTone');
  setText('label[for="fltNoise"]', 'fltNoise');
  setText('label[for="fltGrain"]', 'fltGrain');
  setText('label[for="fltVig"]', 'fltVig');
  setText('#profSaveModal h2', 'profSaveTitle');
  setText('#profSaveModal p', 'profSaveSub');
  setPh('#profSaveInput', 'profSavePh');
  setText('#btnProfSaveCancel', 'btnCancel');
  setText('#btnProfSaveOk', 'profSaveBtn');
  setText('#profDelModal h2', 'profDelTitle');
  setText('#btnProfDelCancel', 'btnCancel');
  setText('#btnProfDelOk', 'profDelBtn');
  const ptGrps = document.querySelectorAll('#panelT .ptGrp > span');
  if (ptGrps[0]) ptGrps[0].textContent = t('fltCas');
  if (ptGrps[1]) ptGrps[1].textContent = t('fltUp');
  if (ptGrps[2]) ptGrps[2].textContent = t('fltAuto');
  setTitle('#ptBypass', 'fltEyeTitle');
  setText('[data-cas="0"]', 'off');
  setText('[data-cas="1"]', 'subtle');
  setText('[data-cas="2"]', 'strong');
  setText('[data-up="0"]', 'off');
  setText('[data-up="1"]', 'on');
  setText('[data-auto="0"]', 'off');
  setText('[data-auto="1"]', 'on');

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

  // Help popup
  const hp = document.getElementById('helpPop');
  if (hp) {
    const grid = hp.querySelector('.helpGrid');
    if (grid) {
      grid.innerHTML = curLang === 'cs'
        ? `<div class="helpCol">
            <div><h4>Přehrávání a okno</h4>
              <div class="hrow"><span class="hkeys"><kbd>klik</kbd> / <kbd>Mezerník</kbd></span><span>pauza / přehrát</span></div>
              <div class="hrow"><span class="hkeys"><kbd>2× klik</kbd> / <kbd>F</kbd></span><span>maximalizace / okno</span></div>
              <div class="hrow"><span class="hkeys"><kbd>tah</kbd></span><span>přesun okna</span></div>
              <div class="hrow"><span class="hkeys"><kbd>↑</kbd> <kbd>↓</kbd></span><span>přepnout stanici</span></div>
              <div class="hrow"><span class="hkeys"><kbd>Esc</kbd></span><span>zavřít panely</span></div>
            </div>
            <div><h4>Panely a filtry</h4>
              <div class="hrow"><span class="hkeys"><kbd>pravý okraj</kbd></span><span>zdroje, oblíbené, stanice</span></div>
              <div class="hrow"><span class="hkeys"><kbd>levý okraj</kbd></span><span>program (EPG) a hledání</span></div>
              <div class="hrow"><span class="hkeys"><kbd>horní okraj</kbd></span><span>obrazové filtry a GPU shadery</span></div>
              <div class="hrow"><span class="hkeys"><kbd>dolní okraj</kbd></span><span>aktuální pořad a timeshift</span></div>
            </div>
          </div>
          <div class="helpCol">
            <div><h4>EPG a připomínky</h4>
              <div class="hrow"><span class="hkeys">⏰</span><span>připomenout a přepnout</span></div>
              <div class="hrow"><span class="hkeys">📌</span><span>automatické přeplánování</span></div>
              <div class="hrow"><span class="hkeys">★</span><span>oblíbená stanice (tah = pořadí)</span></div>
            </div>
            <div><h4>Nahrávání a archiv</h4>
              <div class="hrow"><span class="hkeys">⏺</span><span>živé / plánované nahrávání</span></div>
              <div class="hrow"><span class="hkeys">⬇</span><span>stažení z archivu na pozadí</span></div>
              <div class="hrow"><span class="hkeys">⏮ / ▶</span><span>od začátku / zpět na živé</span></div>
            </div>
          </div>`
        : `<div class="helpCol">
            <div><h4>Playback &amp; Window</h4>
              <div class="hrow"><span class="hkeys"><kbd>click</kbd> / <kbd>Space</kbd></span><span>pause / resume</span></div>
              <div class="hrow"><span class="hkeys"><kbd>2× click</kbd> / <kbd>F</kbd></span><span>maximize / window</span></div>
              <div class="hrow"><span class="hkeys"><kbd>drag</kbd></span><span>move window</span></div>
              <div class="hrow"><span class="hkeys"><kbd>↑</kbd> <kbd>↓</kbd></span><span>switch station</span></div>
              <div class="hrow"><span class="hkeys"><kbd>Esc</kbd></span><span>close panels</span></div>
            </div>
            <div><h4>Panels &amp; Filters</h4>
              <div class="hrow"><span class="hkeys"><kbd>right edge</kbd></span><span>sources, favorites, stations</span></div>
              <div class="hrow"><span class="hkeys"><kbd>left edge</kbd></span><span>program guide (EPG) &amp; search</span></div>
              <div class="hrow"><span class="hkeys"><kbd>top edge</kbd></span><span>video filters &amp; GPU shaders</span></div>
              <div class="hrow"><span class="hkeys"><kbd>bottom edge</kbd></span><span>current program &amp; timeshift</span></div>
            </div>
          </div>
          <div class="helpCol">
            <div><h4>EPG &amp; Reminders</h4>
              <div class="hrow"><span class="hkeys">⏰</span><span>remind &amp; auto-switch</span></div>
              <div class="hrow"><span class="hkeys">📌</span><span>auto-replan recurring show</span></div>
              <div class="hrow"><span class="hkeys">★</span><span>favorite station (drag = order)</span></div>
            </div>
            <div><h4>Recording &amp; Archive</h4>
              <div class="hrow"><span class="hkeys">⏺</span><span>live / scheduled recording</span></div>
              <div class="hrow"><span class="hkeys">⬇</span><span>background archive download</span></div>
              <div class="hrow"><span class="hkeys">⏮ / ▶</span><span>from start / back to live</span></div>
            </div>
          </div>`;
    }
  }
}
