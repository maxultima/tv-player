// Pure JS helpers for Vodafone TV CZ (Kaltura Cloud TV + Nagra DAS/SSM).
// Zero browser/Tauri dependencies so all parsing and crypto are directly unit-testable.

export const VODAFONE_WIDEVINE_DRM_ID = 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed';
export const VODAFONE_DMS_APP = 'com.kaltura.vodafone.group.cz.web.pc.chrome';
export const VODAFONE_DMS_CVER = '0.89.3';
export const VODAFONE_BRAND_ID = '111'; // pc.chrome

function b64ToBytes(b64) {
  const clean = String(b64 || '').replace(/\s+/g, '');
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(clean, 'base64'));
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64');
  let bin = '';
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin);
}

// Minimal DER/ASN.1 reader for SubjectPublicKeyInfo (RSA public key PEM).
function readDerTagLen(buf, pos) {
  const tag = buf[pos++];
  let len = buf[pos++];
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | buf[pos++];
  }
  return { tag, len, start: pos, end: pos + len };
}

function parseRsaSpkiPem(pem) {
  const body = String(pem || '')
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const der = b64ToBytes(body);
  const seq = readDerTagLen(der, 0);
  if (seq.tag !== 0x30) throw new Error('Neplatný RSA veřejný klíč (chybí SEQUENCE).');
  const algId = readDerTagLen(der, seq.start);
  let bitPos = algId.end;
  // Support both SPKI (AlgorithmIdentifier + BIT STRING) and raw PKCS#1 RSAPublicKey (INTEGER n + INTEGER e).
  let innerStart;
  if (algId.tag === 0x30) {
    const bitStr = readDerTagLen(der, bitPos);
    if (bitStr.tag !== 0x03) throw new Error('Neplatný RSA klíč (chybí BIT STRING).');
    // Skip unused-bits byte (0x00), then read inner SEQUENCE.
    const innerSeq = readDerTagLen(der, bitStr.start + 1);
    if (innerSeq.tag !== 0x30) throw new Error('Neplatný RSA klíč (chybí vnitřní SEQUENCE).');
    innerStart = innerSeq.start;
  } else if (algId.tag === 0x02) {
    innerStart = seq.start;
  } else {
    throw new Error('Nepodporovaný formát RSA veřejného klíče.');
  }
  const nEl = readDerTagLen(der, innerStart);
  const eEl = readDerTagLen(der, nEl.end);
  if (nEl.tag !== 0x02 || eEl.tag !== 0x02) throw new Error('Neplatný RSA klíč (chybí n/e).');
  let nBytes = der.subarray(nEl.start, nEl.end);
  while (nBytes.length > 1 && nBytes[0] === 0) nBytes = nBytes.subarray(1);
  let eBytes = der.subarray(eEl.start, eEl.end);
  while (eBytes.length > 1 && eBytes[0] === 0) eBytes = eBytes.subarray(1);
  return { nBytes, eBytes, k: nBytes.length };
}

function bytesToBigInt(bytes) {
  let hex = '0x';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return BigInt(hex);
}

function modPow(base, exp, mod) {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    e >>= 1n;
    b = (b * b) % mod;
  }
  return result;
}

/**
 * RSAES-PKCS1-v1_5 encrypt (matches JSEncrypt used by tv.vodafone.cz).
 * Returns base64 ciphertext string.
 */
export function rsaEncryptPkcs1(pem, plaintext) {
  const { nBytes, eBytes, k } = parseRsaSpkiPem(pem);
  const msg = new TextEncoder().encode(String(plaintext));
  if (msg.length > k - 11) throw new Error('Heslo je příliš dlouhé pro RSA klíč.');
  const psLen = k - msg.length - 3;
  const em = new Uint8Array(k);
  em[0] = 0x00;
  em[1] = 0x02;
  // Cryptographically random non-zero padding bytes
  const rnd = new Uint8Array(psLen * 2);
  let filled = 0;
  while (filled < psLen) {
    globalThis.crypto.getRandomValues(rnd);
    for (let i = 0; i < rnd.length && filled < psLen; i++) {
      if (rnd[i] !== 0) em[2 + filled++] = rnd[i];
    }
  }
  em[2 + psLen] = 0x00;
  em.set(msg, 3 + psLen);

  const m = bytesToBigInt(em);
  const n = bytesToBigInt(nBytes);
  const e = bytesToBigInt(eBytes);
  const c = modPow(m, e, n);
  const hex = c.toString(16).padStart(k * 2, '0');
  const out = new Uint8Array(k);
  for (let i = 0; i < k; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytesToB64(out);
}

/**
 * Parse DMS JSON config returned by 3062.dms-vfp2.ott.kaltura.com/getconfig.
 */
export function parseDmsConfig(dmsJson) {
  const p = (dmsJson && dmsJson.params) || {};
  const nagraArr = Array.isArray(p.NagraSettings) ? p.NagraSettings : [];
  const nagra = {};
  for (const item of nagraArr) {
    if (item && typeof item === 'object') Object.assign(nagra, item);
  }
  const vtvApiGw = (p.VTVApiGW && p.VTVApiGW.JsonGW) || 'https://apigw.cz.vtv.vodafone.com/vtv/';
  const phoenix = (p.GatewaysPhoenix && p.GatewaysPhoenix.JsonGW) || (vtvApiGw + 'phoenix/v1/api_v3/service/');
  const tvpapi = (p.Gateways && p.Gateways.JsonGW) || (vtvApiGw + 'tvapi/v1/gateways/jsonpostgw.aspx');
  const cdnEpg = (p.onDemandEPG && p.onDemandEPG.CDNBasePath) || 'https://cdn.cz.vtv.vodafone.com/';
  return {
    partnerId: Number(p.GID || 3062),
    apiVersion: String(p.apiVersion || '5.3.2'),
    vtvApiGw,
    phoenix,
    tvpapi,
    cdnEpg,
    publicKeyUrl: p.RIMPublicKey || 'https://3062.static-vfp2.ott.kaltura.com/3062/files/rsa_2048_pub.pem',
    licenseServerUrl: nagra.SSPLicenseServerUrl || 'https://vdcr01h5.anycast.nagra.com/',
    tenantId: nagra.TenantID || 'VDCR01H5',
    opVaultAddress: nagra['OpVault-Address'] || 'https://vdcr01h5-ov.anycast.nagra.com/filedownload/v1/opvault/.json',
  };
}

const FILE_TYPE_PRIO = [
  'DASH_AVC_FULLHD_HTTPS',
  'DASH_AVC_HD_HTTPS',
  'DASH_AVC_SD_HTTPS',
  'DASH_HEVC_UHD_HTTPS',
];

function pickBestMediaFile(mediaFiles) {
  if (!Array.isArray(mediaFiles) || !mediaFiles.length) return null;
  for (const wanted of FILE_TYPE_PRIO) {
    const hit = mediaFiles.find((f) => f && f.type === wanted && f.id);
    if (hit) return hit;
  }
  return mediaFiles.find((f) => f && /DASH/i.test(String(f.type || '')) && f.id)
    || mediaFiles.find((f) => f && f.id && !/TRAILER|DEEP/i.test(String(f.type || '')))
    || null;
}

export function normalizeKalturaLogoUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  // Oprava drive nacachovanych URL s /width/200/height/0 (Kaltura z height/0 udela 75px) zpet na nativni 105x55.
  return url.replace(/\/width\/200\/height\/0(?=\/|$)/i, '/width/105/height/55');
}

function isWideRatio(ratio) {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(String(ratio || ''));
  return !!(m && Number(m[1]) > Number(m[2]));
}

function pickChannelLogo(images) {
  if (!Array.isArray(images) || !images.length) return null;
  const valid = images.filter((im) => im && im.url);
  if (!valid.length) return null;
  // Preferovat originalni siroke logo (napr. 105x55 / _1) pred ctvercovou 1:1 variantou (216x216 / _12),
  // bez prepisovani width/height parametru v URL (Kaltura zachova pomer jen s vlastnimi rozmery).
  const wideByDims = valid.find((im) => Number(im.width) > Number(im.height) && Number(im.width) <= 400);
  if (wideByDims) return wideByDims.url;
  const wideByUrl = valid.find((im) => {
    const m = /\/width\/(\d+)\/height\/(\d+)/i.exec(im.url);
    return m && Number(m[1]) > Number(m[2]);
  });
  if (wideByUrl) return wideByUrl.url;
  const wideByRatio = valid.find((im) => isWideRatio(im.ratio));
  if (wideByRatio) return wideByRatio.url;
  const byType = valid.find((im) => /logo|channel/i.test(String(im.imageTypeName || '')));
  if (byType) return byType.url;
  return valid[0].url;
}

function metaVal(metas, key) {
  if (!metas || typeof metas !== 'object') return undefined;
  const m = metas[key];
  return m && typeof m === 'object' ? m.value : m;
}

function tagVals(tags, key) {
  if (!tags || typeof tags !== 'object') return [];
  const t = tags[key];
  if (!t || !Array.isArray(t.objects)) return [];
  return t.objects.map((x) => x && x.value).filter((x) => x !== undefined && x !== null);
}

/**
 * Parse Kaltura KalturaLiveAsset objects into TV Client station records.
 * @param {Array} objects Raw objects from asset/action/list (typeIn: "735")
 * @param {Set<string>|null} subscribedSet Optional set of entitled subscription IDs
 */
export function parseVodafoneChannels(objects, subscribedSet = null, entitledAssetIds = null) {
  if (!Array.isArray(objects)) return [];
  const out = [];
  for (const o of objects) {
    if (!o || !o.id || !o.name) continue;
    const isDeepLink = metaVal(o.metas, 'IsDeepLink') === true || metaVal(o.metas, 'IsDeepLink') === 'true';
    if (isDeepLink) continue;
    const mf = pickBestMediaFile(o.mediaFiles);
    if (!mf) continue;

    const epgRaw = o.externalIds || o.epgChannelId || o.externalId || '';
    const epgId = String(epgRaw).trim() || String(o.id);
    const lcnRaw = metaVal(o.metas, 'Channel number');
    const lcn = Number.isFinite(Number(lcnRaw)) && String(lcnRaw || '').trim() !== '' ? Number(lcnRaw) : 9999;
    const subId = metaVal(o.metas, 'subscription_id');
    let noAccess = false;
    if (entitledAssetIds && entitledAssetIds.size > 0) {
      if (!entitledAssetIds.has(String(o.id))) noAccess = true;
    } else if (subscribedSet && subscribedSet.size > 0 && subId !== undefined && subId !== null && String(subId).trim() !== '') {
      const ids = String(subId).split(/[,\s|]+/).filter(Boolean);
      if (ids.length && !ids.some((id) => subscribedSet.has(id))) noAccess = true;
    }

    const name = String(o.name).trim();
    out.push({
      vfId: String(o.id),
      vfEpgId: epgId,
      vfFileId: String(mf.id),
      vfFileType: String(mf.type || ''),
      name,
      ini: name.slice(0, 3).toUpperCase(),
      color: '#e60000',
      logo: pickChannelLogo(o.images),
      streamUrl: null,
      drm: null,
      locked: noAccess,
      noAccess,
      timeshift: 7 * 24 * 60, // Vodafone TV CZ ma 7denni zpetne shlednuti (u poradu rizeno tagem/catchup)
      order: lcn,
    });
  }
  out.sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name, 'cs'));
  return out;
}

function hhmm(ms) {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/**
 * Parse Kaltura KalturaProgramAsset objects into TV Client EPG rows grouped by epgChannelId.
 */
export function parseVodafoneEpgObjects(objects) {
  const byChan = {};
  if (!Array.isArray(objects)) return byChan;
  for (const e of objects) {
    if (!e || !e.startDate || !e.endDate) continue;
    const cid = String(e.epgChannelId || '').trim();
    if (!cid) continue;
    const s = Number(e.startDate) * 1000;
    const e2 = Number(e.endDate) * 1000;
    if (!Number.isFinite(s) || !Number.isFinite(e2) || e2 <= s) continue;
    const imgs = Array.isArray(e.images) ? e.images : [];
    const imgObj = imgs.find((im) => im && im.url && (im.ratio === '16:9' || im.ratio === '4:3')) || imgs.find((im) => im && im.url);
    const catchupTag = tagVals(e.tags, 'w_catchup')[0];
    const canTimeshift = e.enableCatchUp === true || catchupTag === 'true' || catchupTag === true;
    const row = {
      id: e.id !== undefined && e.id !== null ? String(e.id) : null,
      t: hhmm(s),
      e: hhmm(e2),
      title: String(e.name || '?'),
      desc: String(e.description || '').slice(0, 500),
      img: (imgObj && imgObj.url) || null,
      s,
      e2,
      day: new Date(s).toDateString(),
      canTimeshift,
    };
    if (!byChan[cid]) byChan[cid] = [];
    byChan[cid].push(row);
  }
  for (const rows of Object.values(byChan)) {
    rows.sort((a, b) => a.s - b.s);
  }
  return byChan;
}

/**
 * Build KalturaBookmark request body used by Vodafone TV SSM (bookSlot / start / renewal / tearDown).
 */
export function buildVodafoneBookmarkBody({ assetId, assetType, fileId, action, position = 0, programId, apiVersion, ks }) {
  const bookmark = {
    objectType: 'KalturaBookmark',
    id: String(assetId),
    type: assetType === 'epg' ? 'EPG' : 'MEDIA',
    position: Math.max(0, Math.floor(position || 0)),
    playerData: {
      objectType: 'KalturaBookmarkPlayerData',
      fileId: Number(fileId) || 0,
      action,
    },
  };
  if (programId !== undefined && programId !== null && String(programId) !== '') {
    bookmark.programId = Number(programId) || programId;
  }
  return { bookmark, apiVersion, ks };
}

/**
 * Parse authentication/v2/credentials response (KalturaLoginResponse + vtv-sessionkey header).
 */
export function parseVodafoneLoginResponse(body, headers, status = 200) {
  const result = (body && body.result) || body || {};
  if (status >= 400 || result.error) {
    const err = result.error || {};
    const msg = err.message || (typeof body === 'string' ? body.slice(0, 180) : '') || ('HTTP ' + status);
    throw new Error(msg + (err.code ? ' [' + err.code + ']' : ''));
  }
  const ls = result.loginSession || result;
  const ks = ls && ls.ks;
  if (!ks) throw new Error('Vodafone TV přihlášení nevrátilo KS token.');
  const hdrs = headers && typeof headers === 'object' ? headers : {};
  const skRaw = hdrs['vtv-sessionkey'] || hdrs['VTV-SessionKey'] || '';
  let sk = null;
  if (skRaw) {
    try { sk = JSON.parse(skRaw); } catch {}
  }
  const sessFallback = result.session || {};
  const deviceId = String((sk && sk.deviceId) || sessFallback.deviceId || '');
  const keyId = String((sk && sk.sessionKey && sk.sessionKey.keyId) || sessFallback.keyId || '');
  const encryptedSessionRight = (sk && sk.encryptedSessionRight) || sessFallback.encryptedSessionRight || null;
  const alg = String(
    (sk && Array.isArray(sk.signingAlgorithms) && sk.signingAlgorithms[0])
    || sessFallback.signingAlgorithm
    || 'HS256',
  );
  const cdnTokens = ((result.cts && result.cts.tokens) || []).map((tk) => ({
    aud: tk.aud || [],
    token: tk.token || '',
  }));
  return {
    ks: String(ks),
    expiry: ls.expiry ? Number(ls.expiry) * 1000 : (Date.now() + 3600 * 1000),
    userId: String((result.user && result.user.id) || ''),
    householdId: String((result.user && result.user.householdId) || ''),
    deviceId,
    keyId,
    encryptedSessionRight,
    alg,
    cdnTokens,
  };
}

/**
 * Build Vodafone TV Visual Scrubber sprite URL and tile index for a given offset in seconds.
 * Matches tv.vodafone.cz: SECONDS_PER_SPRITE=200, NUMBER_THUMBNAILS_PER_SPRITE=10 (20s/thumb), 720p (10x1 strip).
 */
export function buildVodafoneThumbUrl(baseUrl, progressSec, spriteType = 'CATCHUP') {
  if (typeof baseUrl !== 'string' || !baseUrl) return null;
  const sec = Math.max(0, Math.floor(Number(progressSec) || 0));
  const spriteIndex = Math.floor(sec / 200);
  const thumbIndex = Math.floor(sec / 20) - 10 * spriteIndex;
  try {
    const u = new URL(baseUrl);
    u.searchParams.set('sprite', spriteType);
    u.searchParams.set('page', String(spriteIndex));
    u.searchParams.set('resolution', '720p');
    return { url: u.toString(), spriteIndex, thumbIndex };
  } catch {
    return null;
  }
}
