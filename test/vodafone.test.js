import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  rsaEncryptPkcs1,
  parseDmsConfig,
  parseVodafoneChannels,
  parseVodafoneEpgObjects,
  buildVodafoneBookmarkBody,
  parseVodafoneLoginResponse,
  normalizeKalturaLogoUrl,
  buildVodafoneThumbUrl,
} from '../src/lib/vodafone.js';

test('rsaEncryptPkcs1 encrypts password compatible with Node RSA_PKCS1_PADDING privateDecrypt', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const secret = 'P@ssw0rd!Český#2026';
  const b64 = rsaEncryptPkcs1(publicKey, secret);
  assert.equal(typeof b64, 'string');
  assert.ok(b64.length > 200);
  const dec = crypto.privateDecrypt(
    { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(b64, 'base64'),
  );
  assert.equal(dec.toString('utf8'), secret);
});

test('parseDmsConfig extracts gateways, Nagra settings, and public key URL', () => {
  const cfg = parseDmsConfig({
    params: {
      GID: '3062',
      apiVersion: '5.3.2',
      VTVApiGW: { JsonGW: 'https://apigw.cz.vtv.vodafone.com/vtv/' },
      GatewaysPhoenix: { JsonGW: 'https://apigw.cz.vtv.vodafone.com/vtv/phoenix/v1/api_v3/service/' },
      RIMPublicKey: 'https://3062.static-vfp2.ott.kaltura.com/3062/files/rsa_2048_pub.pem',
      onDemandEPG: { CDNBasePath: 'https://cdn.cz.vtv.vodafone.com/' },
      NagraSettings: [
        { SSPLicenseServerUrl: 'https://vdcr01h5.anycast.nagra.com/' },
        { TenantID: 'VDCR01H5' },
        { 'OpVault-Address': 'https://vdcr01h5-ov.anycast.nagra.com/filedownload/v1/opvault/.json' },
      ],
    },
  });
  assert.equal(cfg.partnerId, 3062);
  assert.equal(cfg.apiVersion, '5.3.2');
  assert.equal(cfg.tenantId, 'VDCR01H5');
  assert.equal(cfg.licenseServerUrl, 'https://vdcr01h5.anycast.nagra.com/');
  assert.equal(cfg.opVaultAddress, 'https://vdcr01h5-ov.anycast.nagra.com/filedownload/v1/opvault/.json');
});

test('parseVodafoneChannels sorts by LCN, picks best DASH file, filters deep links, marks locked', () => {
  const raw = [
    {
      id: 10,
      name: 'Netflix App',
      metas: { IsDeepLink: { value: true }, 'Channel number': { value: '1' } },
      mediaFiles: [{ id: 99, type: 'DASH_AVC_FULLHD_HTTPS' }],
    },
    {
      id: 20,
      name: 'Nova HD',
      externalIds: '1002',
      metas: { 'Channel number': { value: '3' }, subscription_id: { value: 'sub-premium' } },
      images: [{ url: 'https://img/nova.png', imageTypeName: 'Channel Logo' }],
      mediaFiles: [
        { id: 201, type: 'DASH_AVC_SD_HTTPS' },
        { id: 202, type: 'DASH_AVC_FULLHD_HTTPS' },
      ],
    },
    {
      id: 30,
      name: 'ČT1 HD',
      externalIds: '1001',
      metas: { 'Channel number': { value: '1' }, subscription_id: { value: 'sub-basic' } },
      images: [{ url: 'https://img/ct1.png', ratio: '1:1' }],
      mediaFiles: [{ id: 301, type: 'DASH_AVC_HD_HTTPS' }],
    },
  ];
  const list = parseVodafoneChannels(raw, new Set(['sub-basic']));
  assert.equal(list.length, 2);
  assert.equal(list[0].name, 'ČT1 HD');
  assert.equal(list[0].vfFileId, '301');
  assert.equal(list[0].locked, false);
  assert.equal(list[1].name, 'Nova HD');
  assert.equal(list[1].vfFileId, '202');
  assert.equal(list[1].locked, true);
  assert.equal(list[1].noAccess, true);
});

test('parseVodafoneEpgObjects groups and sorts programs by epgChannelId', () => {
  const t1 = 1764000000;
  const t2 = t1 + 3600;
  const t3 = t2 + 1800;
  const map = parseVodafoneEpgObjects([
    { id: 2, name: 'Pořad B', epgChannelId: 1001, startDate: t2, endDate: t3, description: 'B desc', enableCatchUp: false },
    { id: 1, name: 'Pořad A', epgChannelId: 1001, startDate: t1, endDate: t2, description: 'A desc', enableCatchUp: true, images: [{ url: 'https://img/a.jpg', ratio: '16:9' }] },
  ]);
  assert.equal(map['1001'].length, 2);
  assert.equal(map['1001'][0].title, 'Pořad A');
  assert.equal(map['1001'][0].img, 'https://img/a.jpg');
  assert.equal(map['1001'][0].canTimeshift, true);
  assert.equal(map['1001'][1].title, 'Pořad B');
  assert.equal(map['1001'][1].canTimeshift, false);
  assert.equal(map['1001'][0].s, t1 * 1000);
});

test('buildVodafoneBookmarkBody formats MEDIA and EPG bookmarks', () => {
  const b = buildVodafoneBookmarkBody({
    assetId: '30',
    assetType: 'media',
    fileId: '301',
    action: 'PLAY',
    position: 12.9,
    programId: '555',
    apiVersion: '5.3.2',
    ks: 'tok',
  });
  assert.equal(b.bookmark.type, 'MEDIA');
  assert.equal(b.bookmark.position, 12);
  assert.equal(b.bookmark.programId, 555);
  assert.equal(b.bookmark.playerData.fileId, 301);
  assert.equal(b.bookmark.playerData.action, 'PLAY');
});

test('parseVodafoneLoginResponse extracts KalturaLoginResponse ks and vtv-sessionkey header', () => {
  const res = parseVodafoneLoginResponse(
    {
      result: {
        objectType: 'KalturaLoginResponse',
        loginSession: { ks: 'ks-token-123', expiry: 1800000000, refreshToken: 'ref-1' },
        user: { id: 'u1', householdId: 'h1' },
        cts: { tokens: [{ aud: ['vtv'], token: 'cdn-tok' }] },
      },
    },
    {
      'vtv-sessionkey': JSON.stringify({
        deviceId: 'dev-42',
        sessionKey: { keyId: 'key-99' },
        encryptedSessionRight: 'enc-right',
        signingAlgorithms: ['HS256'],
      }),
    },
    200,
  );
  assert.equal(res.ks, 'ks-token-123');
  assert.equal(res.expiry, 1800000000 * 1000);
  assert.equal(res.userId, 'u1');
  assert.equal(res.householdId, 'h1');
  assert.equal(res.deviceId, 'dev-42');
  assert.equal(res.keyId, 'key-99');
  assert.equal(res.encryptedSessionRight, 'enc-right');
  assert.equal(res.alg, 'HS256');
  assert.equal(res.cdnTokens.length, 1);
});

test('pickChannelLogo prefers native wide logo over square 1:1 without distorting URL', () => {
  const list = parseVodafoneChannels([
    {
      id: 1,
      name: 'Nova HD',
      externalIds: '100',
      images: [
        { url: 'https://3062.images-vfp2.ott.kaltura.com/Service.svc/GetImage/p/3062/entry_id/x_12/version/7/width/216/height/216/quality/100', width: 216, height: 216, ratio: '1:1' },
        { url: 'https://3062.images-vfp2.ott.kaltura.com/Service.svc/GetImage/p/3062/entry_id/x_1/version/7/width/105/height/55/quality/100', width: 105, height: 55, ratio: '2:1' },
      ],
      mediaFiles: [{ id: 10, type: 'DASH_AVC_FULLHD_HTTPS' }],
    },
  ]);
  assert.equal(list[0].logo, 'https://3062.images-vfp2.ott.kaltura.com/Service.svc/GetImage/p/3062/entry_id/x_1/version/7/width/105/height/55/quality/100');
  assert.equal(
    normalizeKalturaLogoUrl('https://3062.images-vfp2.ott.kaltura.com/x/width/200/height/0/quality/100'),
    'https://3062.images-vfp2.ott.kaltura.com/x/width/105/height/55/quality/100',
  );
});

test('parseVodafoneChannels marks unentitled channels locked when entitledAssetIds is provided', () => {
  const list = parseVodafoneChannels(
    [
      { id: 101, name: 'ČT1 HD', mediaFiles: [{ id: 1, type: 'DASH_AVC_FULLHD_HTTPS' }] },
      { id: 102, name: 'Nova Sport 3 HD', mediaFiles: [{ id: 2, type: 'DASH_AVC_FULLHD_HTTPS' }] },
    ],
    null,
    new Set(['101']),
  );
  assert.equal(list.find((c) => c.vfId === '101').locked, false);
  assert.equal(list.find((c) => c.vfId === '102').locked, true);
  assert.equal(list.find((c) => c.vfId === '102').noAccess, true);
});

test('buildVodafoneThumbUrl computes sprite page and thumb index (200s/sprite, 20s/thumb)', () => {
  const u1 = buildVodafoneThumbUrl('https://live.vtv-prod.vodafone.cz/catchup/ch1.mpd?token=abc', 0);
  assert.deepEqual(u1, {
    url: 'https://live.vtv-prod.vodafone.cz/catchup/ch1.mpd?token=abc&sprite=CATCHUP&page=0&resolution=720p',
    spriteIndex: 0,
    thumbIndex: 0,
  });
  const u2 = buildVodafoneThumbUrl('https://live.vtv-prod.vodafone.cz/catchup/ch1.mpd', 245);
  assert.deepEqual(u2, {
    url: 'https://live.vtv-prod.vodafone.cz/catchup/ch1.mpd?sprite=CATCHUP&page=1&resolution=720p',
    spriteIndex: 1,
    thumbIndex: 2,
  });
});
