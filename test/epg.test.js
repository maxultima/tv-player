import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normName,
  stripSuffix,
  matchEpgRows,
  liveState,
  parseSltvPlaylist,
} from '../src/lib/epg.js';

// Casovy zaklad testu: 2026-11-16 12:00:00 mistniho casu.
const T0 = new Date(2026, 10, 16, 12, 0, 0).getTime();
const ev = (h1, m1, h2, m2, title) => {
  const s = new Date(2026, 10, 16, h1, m1).getTime();
  const e2 = new Date(2026, 10, 16, h2, m2).getTime();
  return { t: `${String(h1).padStart(2, '0')}:${String(m1).padStart(2, '0')}`, title, s, e2 };
};

describe('normName', () => {
  it('odstrani diakritiku, mezery a velikost', () => {
    assert.equal(normName('Příliš Žluťoučký'), 'priliszlutoucky');
    assert.equal(normName('Nova Cinema'), 'novacinema');
    assert.equal(normName('  ČT1!! '), 'ct1');
  });
  it('prazdne vstupy', () => {
    assert.equal(normName(''), '');
    assert.equal(normName(null), '');
    assert.equal(normName(undefined), '');
  });
});

describe('stripSuffix', () => {
  it('oreze technicke koncovky', () => {
    assert.equal(stripSuffix('novahd'), 'nova');
    assert.equal(stripSuffix('ct1'), 'ct1');
    assert.equal(stripSuffix('programcz'), 'program');
  });
});

describe('matchEpgRows', () => {
  const epg = {
    fanda: [{ title: 'Krimiseriál' }],
    novacinema: [{ title: 'Film' }],
    prima_sport: [{ title: 'Sport' }],
  };
  it('primarne presne id z playlistu (fanda != Nova Action)', () => {
    assert.deepEqual(matchEpgRows(epg, 'Nova Action', 'fanda'), [{ title: 'Krimiseriál' }]);
  });
  it('fallback pres nazev', () => {
    assert.deepEqual(matchEpgRows({ Nova: [1] }, 'Nova', null), [1]);
  });
  it('bez id a bez shody vrati null', () => {
    assert.equal(matchEpgRows(epg, 'Neexistuje', 'neexistuje'), null);
    assert.equal(matchEpgRows({}, 'Nova', 'nova'), null);
    assert.equal(matchEpgRows(null, 'Nova', 'nova'), null);
  });
  it('pomer delek brani falesne shode Nova -> Nova Cinema', () => {
    assert.equal(matchEpgRows({ novacinema: [1] }, 'Nova', 'nova'), null);
  });
  it('suffix shoda projde (Nova HD -> nova)', () => {
    assert.deepEqual(matchEpgRows({ nova: [1] }, 'Nova HD', null), [1]);
  });
});

describe('liveState', () => {
  const rows = [ev(10, 0, 11, 0, 'Dopoledne'), ev(11, 0, 13, 0, 'Poledne'), ev(14, 0, 15, 0, 'Odpoledne')];
  it('najde bezici porad a spocita progress', () => {
    const r = liveState(rows, T0);
    assert.equal(r.now, 'Poledne');
    assert.equal(r.pct, 50);
    assert.equal(r.start, '11:00');
  });
  it('mimo porady vrati dalsi s casem', () => {
    const r = liveState(rows, new Date(2026, 10, 16, 13, 30).getTime());
    assert.equal(r.now, 'Odpoledne (od 14:00)');
    assert.equal(r.pct, 0);
  });
  it('po poslednim poradu vrati null', () => {
    assert.equal(liveState(rows, new Date(2026, 10, 16, 23, 0).getTime()), null);
  });
  it('prazdny vstup', () => {
    assert.equal(liveState([], T0), null);
    assert.equal(liveState(null, T0), null);
  });
});

describe('parseSltvPlaylist', () => {
  const feed = {
    channels: [
      { id: 'nova', name: 'Nova', type: 'tv', locked: 'none', url: 'http://x/1.m3u8', logoUrl: 'http://x/logo.png' },
      { id: 'fanda', name: 'Nova Action', type: 'tv', locked: 'none', url: 'http://x/2.m3u8' },
      { id: 'sport', name: 'Sport', type: 'tv', locked: 'noAccess', url: 'http://x/3.m3u8' },
      { id: 'radio', name: 'Radio', type: 'radio', locked: 'none', url: 'http://x/4.mp3' },
      { id: 'bezurl', name: 'Bez URL', type: 'tv', locked: 'none' },
    ],
  };
  it('filtruje typ a chybejici url, zachova id a locked', () => {
    const out = parseSltvPlaylist(feed);
    assert.equal(out.length, 3);
    const action = out.find((s) => s.name === 'Nova Action');
    assert.equal(action.eid, 'fanda');
    assert.equal(action.locked, false);
    const sport = out.find((s) => s.name === 'Sport');
    assert.equal(sport.locked, true);
    assert.equal(sport.noAccess, true);
  });
  it('radio a bez-url vypadnou', () => {
    const out = parseSltvPlaylist(feed);
    assert.ok(!out.find((s) => s.name === 'Radio'));
    assert.ok(!out.find((s) => s.name === 'Bez URL'));
  });
  it('prazdny/rozbity vstup', () => {
    assert.deepEqual(parseSltvPlaylist({}), []);
    assert.deepEqual(parseSltvPlaylist(null), []);
    assert.deepEqual(parseSltvPlaylist({ channels: [{}, null] }), []);
  });
  it('funguje i pro slovnikovy tvar channels', () => {
    const out = parseSltvPlaylist({ channels: { nova: { id: 'nova', name: 'Nova', url: 'http://x/1' } } });
    assert.equal(out.length, 1);
    assert.equal(out[0].eid, 'nova');
  });
});
