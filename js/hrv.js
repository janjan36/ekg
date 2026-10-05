/* RR-Intervall-Auswertung: Artefaktkorrektur nach Lipponen & Tarvainen (2019, J Med Eng Technol;
 * Standard in Kubios HRV) und HRV-Kennwerte im Zeitbereich.
 * Erkannt werden Extraschläge (ektop), zu lange/kurze, fehlende und zusätzliche Schläge. Für die
 * HRV werden sie ersetzt (interpoliert, geteilt bzw. zusammengefasst) – NN- statt RR-Intervalle. */
(function (global) {
  'use strict';

  const RR_MIN = 300;   // ms  (= 200 /min)
  const RR_MAX = 2000;  // ms  (= 30 /min)
  const ALPHA = 5.2;    // Schwellenfaktor
  const C1 = 0.13, C2 = 0.17;   // Grenzen des Ektopie-Bereichs
  const WIN_QD = 91, WIN_MED = 11;

  function median(values) {
    const s = values.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function quantile(sorted, q) {
    const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  // Gleitende Kennwerte über ein zentriertes Fenster
  function moving(v, win, fn) {
    const half = win >> 1;
    return v.map((_, i) => fn(v.slice(Math.max(0, i - half), Math.min(v.length, i + half + 1))));
  }
  const quartileDev = w => { const s = w.slice().sort((a, b) => a - b); return (quantile(s, 0.75) - quantile(s, 0.25)) / 2; };

  // Klassifiziert jedes Intervall: ok | ectopic | long | short | missed | extra | range
  function classify(rr) {
    const n = rr.length;
    const flags = new Array(n).fill('ok');
    if (n < 4) {
      rr.forEach((v, i) => { if (v < RR_MIN || v > RR_MAX) flags[i] = 'range'; });
      return { flags, med: rr.slice(), th2: rr.map(() => Infinity) };
    }
    const drr = rr.map((v, i) => (i ? v - rr[i - 1] : 0));
    const th1 = moving(drr.map(Math.abs), WIN_QD, quartileDev).map(q => Math.max(1, ALPHA * q));
    const drrs = drr.map((d, i) => d / th1[i]);
    const med = moving(rr, WIN_MED, median);
    const mrr = rr.map((v, i) => { const m = v - med[i]; return m < 0 ? 2 * m : m; });
    const th2 = moving(mrr.map(Math.abs), WIN_QD, quartileDev).map(q => Math.max(1, ALPHA * q));
    const mrrs = mrr.map((m, i) => m / th2[i]);

    for (let i = 0; i < n; i++) {
      if (flags[i] !== 'ok') continue;   // schon als zusätzlicher Schlag zusammengefasst
      if (rr[i] < RR_MIN || rr[i] > RR_MAX) { flags[i] = 'range'; continue; }
      const a = drrs[i];
      const prev = i > 0 ? drrs[i - 1] : 0, next = i < n - 1 ? drrs[i + 1] : 0, next2 = i < n - 2 ? drrs[i + 2] : 0;
      // Ektop: kurzes Intervall gefolgt von langem (oder umgekehrt)
      const s12 = a > 0 ? Math.max(prev, next) : Math.min(prev, next);
      if ((a > 1 && s12 < -C1 * a - C2) || (a < -1 && s12 > -C1 * a + C2)) { flags[i] = 'ectopic'; continue; }
      // Lang oder kurz
      const s22 = a >= 0 ? Math.min(next, next2) : Math.max(next, next2);
      if ((a > 1 && s22 < -1) || (a < -1 && s22 > 1) || Math.abs(mrrs[i]) > 3) {
        if (Math.abs(rr[i] / 2 - med[i]) < th2[i]) flags[i] = 'missed';
        else if (i < n - 1 && Math.abs(rr[i] + rr[i + 1] - med[i]) < th2[i]) { flags[i] = 'extra'; flags[i + 1] = 'extra'; }
        else flags[i] = rr[i] > med[i] ? 'long' : 'short';
      }
    }
    return { flags, med, th2 };
  }

  // rr: ms, rrT: Zeitpunkt (s, Ende des Intervalls), optional
  // → { nn, t, flags, artifacts, share }
  function correct(rr, rrT) {
    rr = Array.from(rr);
    const n = rr.length;
    const { flags } = classify(rr);
    const T = i => (rrT ? rrT[i] : null);
    const ok = flags.map(f => f === 'ok');
    const interp = i => {
      let a = i - 1, b = i + 1;
      while (a >= 0 && !ok[a]) a--;
      while (b < n && !ok[b]) b++;
      if (a >= 0 && b < n) return rr[a] + (rr[b] - rr[a]) * (i - a) / (b - a);
      if (a >= 0) return rr[a];
      if (b < n) return rr[b];
      return null;
    };
    const nn = [], t = [];
    for (let i = 0; i < n; i++) {
      const f = flags[i];
      if (f === 'ok') { nn.push(rr[i]); t.push(T(i)); }
      else if (f === 'missed') {
        nn.push(rr[i] / 2, rr[i] / 2);
        t.push(rrT ? rrT[i] - rr[i] / 2000 : null, T(i));
      } else if (f === 'extra' && i < n - 1 && flags[i + 1] === 'extra') {
        nn.push(rr[i] + rr[i + 1]); t.push(T(i + 1));
        i++;
      } else {
        const v = interp(i);
        if (v != null) { nn.push(v); t.push(T(i)); }
      }
    }
    const artifacts = flags.filter(f => f !== 'ok').length;
    return { nn, t, flags, artifacts, share: n ? artifacts / n : 0 };
  }

  // Für Kompatibilität: true = Intervall unverändert übernommen
  function validateRR(rr) {
    return classify(Array.from(rr)).flags.map(f => f === 'ok');
  }

  function compute(rr) {
    if (!rr || rr.length < 2) return null;
    const c = correct(rr);
    const nn = c.nn;
    if (nn.length < 2) return null;

    const meanRR = nn.reduce((a, b) => a + b, 0) / nn.length;
    const sdnn = Math.sqrt(nn.reduce((a, v) => a + (v - meanRR) ** 2, 0) / (nn.length - 1));
    let sumSq = 0, over50 = 0;
    for (let i = 1; i < nn.length; i++) {
      const d = nn[i] - nn[i - 1];
      sumSq += d * d;
      if (Math.abs(d) > 50) over50++;
    }
    const pairs = nn.length - 1;

    return {
      beats: rr.length,
      artifacts: c.artifacts,
      artifactShare: c.share,
      meanRR,
      meanHR: 60000 / meanRR,
      minHR: 60000 / Math.max(...nn),
      maxHR: 60000 / Math.min(...nn),
      sdnn,
      rmssd: Math.sqrt(sumSq / pairs),
      pnn50: 100 * over50 / pairs,
      valid: c.flags.map(f => f === 'ok')
    };
  }

  global.Hrv = { compute, correct, validateRR, classify };
})(window);
