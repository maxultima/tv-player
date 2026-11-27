// Background Web Worker for non-blocking EPG search with progress and immediate cancellation.
const normName = (s) =>
  (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// Cached per-source channel lists: store[src] = [{ ck, rows: [{ i, t, d, e2, ts, nt?, nd? }] }]
const store = Object.create(null);

let activeJob = 0;
let pendingTimer = null;

function cancelActive() {
  activeJob = 0;
  if (pendingTimer !== null) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
}

self.onmessage = (ev) => {
  const msg = ev.data;
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'sync') {
    store[msg.src] = Array.isArray(msg.channels) ? msg.channels : [];
    return;
  }

  if (msg.type === 'cancel') {
    cancelActive();
    return;
  }

  if (msg.type === 'search') {
    cancelActive();
    const jobId = msg.jobId;
    activeJob = jobId;
    const q = msg.q || '';
    const curSrc = msg.curSrc;
    const curCk = msg.curCk;
    const otherCh = !!msg.otherCh;
    const otherSrc = !!msg.otherSrc;
    const inDesc = !!msg.inDesc;
    const nowMs = msg.nowMs || Date.now();
    const sources = Array.isArray(msg.sources) ? msg.sources : [curSrc];

    // Build ordered scan tasks: current channel -> other channels in curSrc -> other sources
    const tasks = [];
    const curList = store[curSrc] || [];
    for (let i = 0; i < curList.length; i++) {
      const ch = curList[i];
      if (ch.ck === curCk) {
        tasks.push({ kind: 'cur', src: curSrc, ch });
        break;
      }
    }
    if (q.length >= 2 && otherCh) {
      for (let i = 0; i < curList.length; i++) {
        const ch = curList[i];
        if (ch.ck !== curCk) tasks.push({ kind: 'otherCh', src: curSrc, ch });
      }
    }
    if (q.length >= 2 && otherSrc) {
      for (let s = 0; s < sources.length; s++) {
        const sid = sources[s];
        if (sid === curSrc) continue;
        const sList = store[sid] || [];
        for (let i = 0; i < sList.length; i++) {
          tasks.push({ kind: 'otherSrc', src: sid, ch: sList[i] });
        }
      }
    }

    const total = tasks.length;
    if (total === 0) {
      self.postMessage({ type: 'done', jobId, curIdxs: [], otherChMatches: [], otherSrcMatches: {} });
      return;
    }

    let curIdxs = [];
    const otherChMatches = [];
    const otherSrcMatches = Object.create(null);
    let idx = 0;

    const step = () => {
      pendingTimer = null;
      if (activeJob !== jobId) return;

      const t0 = performance.now();
      while (idx < total) {
        const task = tasks[idx++];
        const rows = task.ch.rows;
        const hits = [];
        for (let r = 0; r < rows.length; r++) {
          const row = rows[r];
          if (row.e2 && row.e2 <= nowMs && !row.ts) continue;
          if (row.nt === undefined) row.nt = normName(row.t);
          let ok = row.nt.includes(q);
          if (!ok && inDesc && row.d) {
            if (row.nd === undefined) row.nd = normName(row.d);
            ok = row.nd.includes(q);
          }
          if (ok) hits.push(row.i);
        }
        if (task.kind === 'cur') {
          curIdxs = hits;
        } else if (hits.length) {
          if (task.kind === 'otherCh') {
            otherChMatches.push({ ck: task.ch.ck, idxs: hits });
          } else {
            if (!otherSrcMatches[task.src]) otherSrcMatches[task.src] = [];
            otherSrcMatches[task.src].push({ ck: task.ch.ck, idxs: hits });
          }
        }
        // Yield frequently so new keystrokes can cancel immediately and progress updates stay smooth
        if (performance.now() - t0 >= 12) break;
      }

      if (activeJob !== jobId) return;
      self.postMessage({ type: 'progress', jobId, done: idx, total });

      if (idx < total) {
        pendingTimer = setTimeout(step, 0);
      } else {
        activeJob = 0;
        self.postMessage({ type: 'done', jobId, curIdxs, otherChMatches, otherSrcMatches });
      }
    };

    step();
  }
};
