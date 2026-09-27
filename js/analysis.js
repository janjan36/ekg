/* Automatische EKG-Auswertung für ein Einkanal-EKG mit 130 Hz – Näherungswerte, keine Diagnose.
 *  1. R-Zacken-Erkennung (vereinfachter Pan-Tompkins-Algorithmus)
 *  2. Signalqualität in 2-s-Abschnitten (kein Signal, Bewegung, Störung)
 *  3. Schlagtypen: N normal, S vorzeitig mit normaler Form (supraventrikulär),
 *     V vorzeitig mit abweichender Form (ventrikulär), A abweichende Form, U nicht auswertbar
 *  4. Rhythmus: Frequenz, Regelmäßigkeit (Kriterien nach Dash et al. 2009), Pausen
 *  5. EKG-Zeiten (PQ, QRS, QT, QTc) am Median-Schlag */
(function (global) {
  'use strict';

  const { Biquad } = global.EkgFilters;

  /* ---------- Hilfsfunktionen ---------- */
  function zeroPhase(x, makeStages) {
    const n = x.length, out = new Float32Array(n);
    let st = makeStages();
    for (let i = 0; i < n; i++) { let v = x[i]; for (const s of st) v = s.process(v); out[i] = v; }
    st = makeStages();
    for (let i = n - 1; i >= 0; i--) { let v = out[i]; for (const s of st) v = s.process(v); out[i] = v; }
    return out;
  }

  function median(v) {
    if (!v.length) return null;
    const s = Array.from(v).sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  const mean = v => v.reduce((a, b) => a + b, 0) / v.length;

  function medianOfSegments(segs) {
    const len = segs[0].length, out = new Float32Array(len), col = new Float32Array(segs.length);
    for (let j = 0; j < len; j++) {
      for (let k = 0; k < segs.length; k++) col[k] = segs[k][j];
      col.sort();
      const m = col.length >> 1;
      out[j] = col.length % 2 ? col[m] : (col[m - 1] + col[m]) / 2;
    }
    return out;
  }

  function pearson(a, b) {
    const n = a.length;
    let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < n; i++) {
      const da = a[i] - ma, db = b[i] - mb;
      sab += da * db; saa += da * da; sbb += db * db;
    }
    return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
  }

  /* ---------- 1. R-Zacken ---------- */
  function detectR(clean, fs) {
    const n = clean.length;
    const band = zeroPhase(clean, () => [Biquad.highpass(fs, 5), Biquad.lowpass(fs, 15)]);
    const slope = new Float32Array(n);
    const sq = new Float32Array(n);
    for (let i = 1; i < n - 1; i++) {
      slope[i] = band[i + 1] - band[i - 1];
      sq[i] = slope[i] * slope[i];
    }
    // Gleitender Mittelwert über 150 ms (zentriert, daher ohne Verzögerung)
    const half = Math.round(0.075 * fs);
    const pre = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + sq[i];
    const integ = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - half), b = Math.min(n, i + half + 1);
      integ[i] = (pre[b] - pre[a]) / (b - a);
    }

    const cand = [];
    for (let i = 1; i < n - 1; i++) if (integ[i] > integ[i - 1] && integ[i] >= integ[i + 1]) cand.push(i);
    const maxSlopeNear = i => {
      let m = 0;
      for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) m = Math.max(m, Math.abs(slope[j]));
      return m;
    };

    const refr = Math.round(0.25 * fs);
    const twave = Math.round(0.36 * fs);
    let initMax = 0;
    for (let i = 0; i < Math.min(n, 2 * fs); i++) initMax = Math.max(initMax, integ[i]);
    let spki = 0.5 * initMax;
    let npki = median(integ.subarray(0, Math.min(n, 2 * fs))) || 0;
    let thr = npki + 0.25 * (spki - npki);

    const qrs = [], qrsSlope = [];
    let lastK = -1, rrAvg = null;
    const accept = (k, weight) => {
      const c = cand[k];
      qrs.push(c);
      qrsSlope.push(maxSlopeNear(c));
      spki = weight * integ[c] + (1 - weight) * spki;
      lastK = k;
      if (qrs.length >= 2) {
        const recent = [];
        for (let j = Math.max(1, qrs.length - 8); j < qrs.length; j++) recent.push(qrs[j] - qrs[j - 1]);
        rrAvg = mean(recent);
      }
    };

    for (let k = 0; k < cand.length; k++) {
      const c = cand[k], v = integ[c];
      // Rücksuche: wurde ein Schlag übersehen?
      if (rrAvg && qrs.length && c - qrs[qrs.length - 1] > 1.66 * rrAvg) {
        const last = qrs[qrs.length - 1];
        let best = -1;
        for (let j = lastK + 1; j < k; j++) {
          const cj = cand[j];
          if (cj - last > refr && c - cj > refr && integ[cj] > 0.5 * thr && (best < 0 || integ[cj] > integ[cand[best]])) best = j;
        }
        if (best >= 0) accept(best, 0.25);
      }
      const last = qrs.length ? qrs[qrs.length - 1] : -Infinity;
      if (v > thr && c - last > refr) {
        // T-Welle? Kurz nach einem Schlag und deutlich flacher
        if (c - last < twave && maxSlopeNear(c) < 0.5 * qrsSlope[qrsSlope.length - 1]) {
          npki = 0.125 * v + 0.875 * npki;
        } else {
          accept(k, 0.125);
        }
      } else {
        npki = 0.125 * v + 0.875 * npki;
      }
      thr = npki + 0.25 * (spki - npki);
    }

    // Genaue Lage der R-Zacke im gefilterten EKG, mit einheitlicher Polarität
    const win = Math.round(0.08 * fs);
    const peakIn = (q, score) => {
      let best = q;
      for (let j = Math.max(0, q - win); j <= Math.min(n - 1, q + win); j++) if (score(j) > score(best)) best = j;
      return best;
    };
    const signed = qrs.map(q => clean[peakIn(q, j => Math.abs(clean[j]))]);
    const pol = (median(signed) || 0) >= 0 ? 1 : -1;
    const r = [];
    for (const q of qrs) {
      const i = peakIn(q, j => pol * clean[j]);
      if (!r.length || i - r[r.length - 1] > refr) r.push(i);
    }
    return { r, pol };
  }

  /* ---------- 2. Signalqualität ---------- */
  function assessQuality(clean, r, fs) {
    const n = clean.length, win = 2 * fs;
    const near = new Uint8Array(n);
    const ex = Math.round(0.1 * fs);
    for (const i of r) near.fill(1, Math.max(0, i - ex), Math.min(n, i + ex + 1));
    const rAmp = r.length ? median(r.map(i => Math.abs(clean[i]))) : 0;
    const noiseThr = Math.max(40, 0.05 * rAmp);

    const bad = new Uint8Array(n);
    const segments = [];
    for (let s = 0, e; s < n; s = e) {
      e = Math.min(n, s + win);
      if (n - e < fs) e = n;   // kurzen Rest an den letzten Abschnitt anhängen
      const sorted = Array.from(clean.subarray(s, e)).sort((a, b) => a - b);
      const range = sorted[Math.floor(0.98 * (sorted.length - 1))] - sorted[Math.floor(0.02 * (sorted.length - 1))];
      // Rauschen = Effektivwert der 2. Ableitung außerhalb der QRS-Komplexe, ohne die höchsten 4 %
      // (ein übersehener QRS-Komplex fällt so kaum ins Gewicht, eine kurze Störung aber schon)
      const d2 = [];
      for (let i = Math.max(1, s); i < Math.min(n - 1, e); i++) {
        if (!near[i]) d2.push((clean[i + 1] - 2 * clean[i] + clean[i - 1]) ** 2);
      }
      d2.sort((a, b) => a - b);
      const keep = Math.max(1, Math.floor(d2.length * 0.96));
      let sum = 0;
      for (let i = 0; i < keep && i < d2.length; i++) sum += d2[i];
      const noise = d2.length ? Math.sqrt(sum / keep) : 0;
      const type = range < 80 ? 'flat' : range > 5000 ? 'motion' : noise > noiseThr ? 'noise' : null;
      if (!type) continue;
      bad.fill(1, s, e);
      const last = segments[segments.length - 1];
      if (last && last.end === s && last.type === type) last.end = e;
      else segments.push({ start: s, end: e, type });
    }
    let badCount = 0;
    for (let i = 0; i < n; i++) badCount += bad[i];
    return { bad, segments, good: n ? 1 - badCount / n : 0, rAmp };
  }

  /* ---------- 3. Schlagtypen ---------- */
  function classify(clean, r, fs, bad) {
    const n = clean.length;
    const A = Math.round(0.1 * fs), B = Math.round(0.12 * fs);
    const usable = r.map(i => !bad[i]);
    const rr = r.map((i, k) => (k && usable[k] && usable[k - 1] ? (i - r[k - 1]) * 1000 / fs : null));
    const refs = r.map((_, k) => {
      const v = [];
      for (let j = Math.max(1, k - 6); j <= Math.min(r.length - 1, k + 6); j++) {
        if (j !== k && j !== k + 1 && rr[j] != null) v.push(rr[j]);
      }
      return v.length >= 3 ? median(v) : null;
    });
    // Erwartetes RR an Stelle k aus den Nachbarn k−3…k−1 und k+2…k+3 (k und das folgende,
    // evtl. kompensatorische Intervall ausgelassen), per Parabel angepasst. Folgt der Atemwelle.
    const expectedRR = k => {
      const pts = [];
      for (const j of [k - 3, k - 2, k - 1, k + 2, k + 3]) {
        if (j >= 1 && j < rr.length && rr[j] != null) pts.push([j - k, rr[j]]);
      }
      if (pts.length < 3) return refs[k];
      const med = median(pts.map(p => p[1]));
      const good = pts.filter(p => Math.abs(p[1] - med) < 0.2 * med);   // Ausreißer (andere Extraschläge) raus
      if (good.length < 3) return med;
      // Kleinste Quadrate für y = a + b·x + c·x², Wert bei x = 0 ist a
      const S = [0, 0, 0, 0, 0], T = [0, 0, 0];
      for (const [x, y] of good) {
        for (let p = 0; p < 5; p++) S[p] += x ** p;
        for (let p = 0; p < 3; p++) T[p] += y * x ** p;
      }
      const A = [[S[0], S[1], S[2]], [S[1], S[2], S[3]], [S[2], S[3], S[4]]];
      const det = m => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
        m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
      const D = det(A);
      if (Math.abs(D) < 1e-9) return med;
      const a = det([[T[0], A[0][1], A[0][2]], [T[1], A[1][1], A[1][2]], [T[2], A[2][1], A[2][2]]]) / D;
      const lo = Math.min(...good.map(p => p[1])), hi = Math.max(...good.map(p => p[1]));
      return Math.max(0.85 * lo, Math.min(1.15 * hi, a));
    };

    const SHIFT = 2;
    const seg = (k, sh = 0) => (r[k] - A + sh >= 0 && r[k] + B + sh < n
      ? clean.subarray(r[k] - A + sh, r[k] + B + 1 + sh) : null);
    // Formvergleich mit kleiner Verschiebung: bei 130 Hz liegt die R-Spitze oft zwischen zwei Messpunkten
    const bestCorr = (k, template) => {
      let best = -1;
      for (let sh = -SHIFT; sh <= SHIFT; sh++) {
        const s = seg(k, sh);
        if (s) best = Math.max(best, pearson(s, template));
      }
      return best;
    };

    // Vorlage: Median der Schläge mit unauffälligem Abstand
    let pool = [];
    r.forEach((_, k) => {
      if (usable[k] && rr[k] && refs[k] && Math.abs(rr[k] / refs[k] - 1) < 0.15 && seg(k)) pool.push(seg(k));
    });
    if (pool.length < 3) pool = r.map((_, k) => usable[k] && seg(k)).filter(Boolean);
    const template = pool.length ? medianOfSegments(pool) : null;

    return r.map((i, k) => {
      const corr = template && seg(k) ? bestCorr(k, template) : 1;
      // Vorzeitig = deutlich kürzer als lokal erwartet UND abrupt kürzer als das vorige Intervall.
      // Die atemabhängige Schwankung (auch bei tiefer Atmung) ändert sich dagegen allmählich.
      const exp = rr[k] ? expectedRR(k) : null;
      const premature = rr[k] && exp && rr[k] < 0.82 * exp && (rr[k - 1] == null || rr[k] < 0.9 * rr[k - 1]);
      let type = 'N';
      if (!usable[k]) type = 'U';
      else if (premature) type = corr < 0.7 ? 'V' : 'S';
      else if (corr < 0.5) type = 'A';
      return { i, type, rr: rr[k], corr };
    });
  }

  /* ---------- 4. Rhythmus ---------- */
  function nRmssd(list) {
    if (list.length < 3) return null;
    let s = 0;
    for (let i = 1; i < list.length; i++) s += (list[i] - list[i - 1]) ** 2;
    return Math.sqrt(s / (list.length - 1)) / mean(list);
  }

  // Unregelmäßigkeit nach Dash et al. (2009): nRMSSD, Wendepunkte, Shannon-Entropie
  function irregularity(rr) {
    const N = rr.length;
    if (N < 30) return null;
    let tp = 0;
    for (let i = 1; i < N - 1; i++) if ((rr[i] - rr[i - 1]) * (rr[i + 1] - rr[i]) < 0) tp++;
    const mu = (2 * N - 4) / 3, sigma = Math.sqrt((16 * N - 29) / 90);
    const cut = N >= 40 ? 8 : Math.floor(N * 0.06);
    const trimmed = rr.slice().sort((a, b) => a - b).slice(cut, N - cut);
    const lo = trimmed[0], hi = trimmed[trimmed.length - 1];
    const bins = new Array(16).fill(0);
    for (const v of trimmed) bins[Math.min(15, Math.floor((v - lo) / ((hi - lo) || 1) * 16))]++;
    let she = 0;
    for (const c of bins) if (c) { const p = c / trimmed.length; she -= p * Math.log(p); }
    she /= Math.log(16);
    const nr = nRmssd(rr);
    return { nRmssd: nr, tprOk: Math.abs(tp - mu) <= 1.96 * sigma, she, af: nr > 0.1 && she > 0.7 && Math.abs(tp - mu) <= 1.96 * sigma };
  }

  function rhythmOf(beats) {
    const allRR = [];
    for (let k = 1; k < beats.length; k++) {
      const b = beats[k], p = beats[k - 1];
      if (b.rr == null || 'VAU'.includes(b.type) || 'VAU'.includes(p.type)) continue;
      allRR.push(b.rr);
    }
    const irr = irregularity(allRR);
    const af = !!(irr && irr.af);
    if (af) beats.forEach(b => { if (b.type === 'S') b.type = 'N'; });

    const nnRR = [];
    for (let k = 1; k < beats.length; k++) {
      if (beats[k].rr != null && beats[k].type === 'N' && beats[k - 1].type === 'N') nnRR.push(beats[k].rr);
    }
    const base = nnRR.length >= 3 ? nnRR : allRR;
    const medianRR = median(base);
    const pauses = beats.filter(b => b.rr != null && b.rr > 2000);

    let label;
    if (base.length < 10) label = { code: 'na', text: 'nicht beurteilbar (zu wenige auswertbare Schläge)' };
    else if (af) label = { code: 'irregular', text: 'deutlich unregelmäßig – Muster wie bei Vorhofflimmern möglich' };
    else if (nRmssd(nnRR) > 0.05) label = { code: 'variable', text: 'regelmäßig mit gleichmäßiger Schwankung (z. B. atemabhängig)' };
    else label = { code: 'regular', text: 'regelmäßig' };

    return {
      label, af, irr, pauses, medianRR,
      hr: base.length ? 60000 / mean(base) : null,
      beatsUsed: base.length
    };
  }

  /* ---------- 5. Median-Schlag und EKG-Zeiten ---------- */
  function medianBeat(clean, beats, fs, rrMs) {
    const rrS = (rrMs || 1000) / 1000;
    const pre = Math.round(Math.min(0.3, 0.45 * rrS) * fs);
    const post = Math.round(Math.min(0.62, 0.85 * rrS) * fs);
    const segs = [];
    for (let k = 1; k < beats.length - 1; k++) {
      const b = beats[k];
      if (b.type !== 'N') continue;
      if (b.i - beats[k - 1].i <= pre || beats[k + 1].i - b.i <= post) continue;
      if (b.i - pre < 0 || b.i + post >= clean.length) continue;
      segs.push(clean.subarray(b.i - pre, b.i + post + 1));
    }
    if (segs.length < 5) return null;
    return { y: medianOfSegments(segs.slice(-400)), c: pre, count: segs.length };
  }

  function measure(avg, fs, rrMs) {
    const { c } = avg;
    const n = avg.y.length;
    const S = sec => Math.round(sec * fs);

    // Nulllinie: flachstes Stück im PQ-Segment
    let best = Infinity, base = 0;
    for (let i = Math.max(0, c - S(0.12)); i <= c - S(0.03) - 2; i++) {
      const a = avg.y[i], b = avg.y[i + 1], d = avg.y[i + 2];
      const spread = Math.max(a, b, d) - Math.min(a, b, d);
      if (spread < best) { best = spread; base = (a + b + d) / 3; }
    }
    const y = Float32Array.from(avg.y, v => v - base);
    const dv = i => (y[Math.min(n - 1, i + 1)] - y[Math.max(0, i - 1)]) / 2;
    const rAmp = Math.abs(y[c]);
    let maxSlope = 0;
    for (let i = c - S(0.06); i <= c + S(0.06); i++) maxSlope = Math.max(maxSlope, Math.abs(dv(i)));
    // „Flach“ = kaum Steigung und nahe der Nulllinie (streng genug, dass eine kleine Q-Zacke noch zum QRS zählt)
    const flat = i => Math.abs(dv(i)) < 0.12 * maxSlope && Math.abs(y[i]) < Math.max(25, 0.06 * rAmp);

    let qrsOn = null, qrsOff = null;
    for (let i = c - 1; i >= Math.max(1, c - S(0.12)); i--) if (flat(i)) { qrsOn = i; break; }
    for (let i = c + 1; i <= Math.min(n - 2, c + S(0.16)); i++) if (flat(i)) { qrsOff = i; break; }

    // T-Ende nach der Tangentenmethode
    let tPeak = null, tEnd = null;
    if (qrsOff != null) {
      const s0 = qrsOff + S(0.06), s1 = Math.min(n - 2, c + S(Math.min(0.5, 0.7 * rrMs / 1000)));
      let tp = -1;
      for (let i = s0; i <= s1; i++) if (tp < 0 || Math.abs(y[i]) > Math.abs(y[tp])) tp = i;
      if (tp > s0 && tp < s1 && Math.abs(y[tp]) >= Math.max(40, 0.05 * rAmp)) {
        tPeak = tp;
        const sg = Math.sign(y[tp]);
        let m = -1, steep = 0;
        for (let i = tp + 1; i <= Math.min(n - 2, tp + S(0.2)); i++) {
          const s = -sg * dv(i);
          if (s > steep) { steep = s; m = i; }
        }
        if (m > 0) {
          const te = m + y[m] / (sg * steep);
          if (te > tp && te < Math.min(n, tp + S(0.3))) tEnd = te;
        }
      }
    }

    // P-Welle vor dem QRS-Komplex
    let pOn = null, pPeak = null;
    if (qrsOn != null) {
      const s0 = Math.max(1, c - S(0.3)), s1 = qrsOn - S(0.02);
      let pp = -1;
      for (let i = s0; i <= s1; i++) if (pp < 0 || Math.abs(y[i]) > Math.abs(y[pp])) pp = i;
      const pAmp = pp >= 0 ? Math.abs(y[pp]) : 0;
      if (pp > s0 && pp < s1 && pAmp >= Math.max(25, 0.04 * rAmp)) {
        pPeak = pp;
        for (let i = pp - 1; i >= Math.max(0, pp - S(0.12)); i--) {
          const a = Math.abs(y[i]);
          if (a < 0.2 * pAmp) {
            const b = Math.abs(y[i + 1]);
            pOn = i + (b > a ? (0.2 * pAmp - a) / (b - a) : 0);
            break;
          }
        }
      }
    }

    const dur = (a, b, lo, hi) => {
      if (a == null || b == null) return null;
      const ms = (b - a) * 1000 / fs;
      return ms >= lo && ms <= hi ? ms : null;
    };
    const pq = dur(pOn, qrsOn, 80, 320);
    const qrs = dur(qrsOn, qrsOff, 40, 200);
    const qt = dur(qrsOn, tEnd, 240, 640);
    const rrS = rrMs / 1000;
    return {
      y, c, marks: { pOn, pPeak, qrsOn, qrsOff, tPeak, tEnd },
      pWave: pPeak != null,
      pq, qrs, qt, rr: rrMs,
      qtcB: qt ? qt / Math.sqrt(rrS) : null,
      qtcF: qt ? qt / Math.cbrt(rrS) : null
    };
  }

  /* ---------- Befundtexte ---------- */
  function summarize(res) {
    const f = [];
    const add = (level, text) => f.push({ level, text });
    const { quality, rhythm, times, counts } = res;
    const pct = Math.round(quality.good * 100);

    if (pct >= 90) add('ok', `Signalqualität gut (${pct} % auswertbar)`);
    else if (pct >= 60) add('info', `Signal teilweise gestört (${pct} % auswertbar)`);
    else add('warn', `Signal stark gestört (${pct} % auswertbar) – Auswertung unsicher`);

    if (rhythm.hr) {
      const hr = Math.round(rhythm.hr);
      if (hr < 50) add('info', `Herzfrequenz Ø ${hr} /min – langsam (Bradykardie; in Ruhe bei Trainierten häufig normal)`);
      else if (hr > 100) add('warn', `Herzfrequenz Ø ${hr} /min – schnell (Tachykardie, in Ruhe auffällig)`);
      else add('ok', `Herzfrequenz Ø ${hr} /min – normal`);
    }

    add(rhythm.af ? 'warn' : rhythm.label.code === 'na' ? 'info' : 'ok', `Rhythmus ${rhythm.label.text}`);

    const ect = counts.S + counts.V;
    if (!ect) add('ok', 'Keine Extraschläge erkannt');
    else {
      const parts = [];
      if (counts.S) parts.push(`${counts.S} supraventrikulär`);
      if (counts.V) parts.push(`${counts.V} ventrikulär`);
      const share = ect / Math.max(1, counts.total);
      add(share > 0.05 ? 'warn' : 'info',
        `${ect} Extraschl${ect === 1 ? 'ag' : 'äge'} (${parts.join(', ')} – wahrscheinlich), ${(share * 100).toFixed(1).replace('.', ',')} % der Schläge`);
    }
    if (counts.A) add('info', `${counts.A} Schl${counts.A === 1 ? 'ag' : 'äge'} mit abweichender Form (Störung oder Extraschlag)`);

    if (rhythm.pauses.length) {
      const longest = Math.max(...rhythm.pauses.map(p => p.rr)) / 1000;
      add('warn', `${rhythm.pauses.length} Pause${rhythm.pauses.length > 1 ? 'n' : ''} über 2 s (längste ${longest.toFixed(1).replace('.', ',')} s)`);
    }

    if (times) {
      const notes = [];
      if (times.pq != null && times.pq > 200) notes.push(['info', `PQ-Zeit verlängert (${Math.round(times.pq)} ms)`]);
      if (times.pq != null && times.pq < 120) notes.push(['info', `PQ-Zeit kurz (${Math.round(times.pq)} ms)`]);
      if (times.qrs != null && times.qrs >= 120) notes.push(['info', `QRS verbreitert (${Math.round(times.qrs)} ms)`]);
      if (times.qtcB != null && times.qtcB > 460) notes.push(['warn', `QTc verlängert (${Math.round(times.qtcB)} ms)`]);
      if (times.qtcB != null && times.qtcB < 340) notes.push(['info', `QTc kurz (${Math.round(times.qtcB)} ms)`]);
      notes.forEach(([l, t]) => add(l, t));
      if (!notes.length && (times.qrs != null || times.qtcB != null)) add('ok', 'EKG-Zeiten im Normbereich (Näherung)');
      if (!times.pWave && !rhythm.af) add('info', 'P-Welle nicht sicher erkennbar (beim Brustgurt häufig)');
    } else {
      add('info', 'EKG-Zeiten nicht bestimmbar (zu wenige saubere Schläge)');
    }
    return f;
  }

  /* ---------- Gesamtauswertung ---------- */
  function analyze(raw, fs) {
    if (!raw || raw.length < 8 * fs) return null;
    const clean = zeroPhase(raw, () => [Biquad.highpass(fs, 0.5), Biquad.notch(fs, 50, 8), Biquad.lowpass(fs, 40)]);
    const { r } = detectR(clean, fs);
    const quality = assessQuality(clean, r, fs);
    const beats = classify(clean, r, fs, quality.bad);
    const rhythm = rhythmOf(beats);
    const avg = rhythm.medianRR ? medianBeat(clean, beats, fs, rhythm.medianRR) : null;
    const times = avg ? measure(avg, fs, rhythm.medianRR) : null;
    const counts = { S: 0, V: 0, A: 0, U: 0, N: 0, total: 0 };
    for (const b of beats) { counts[b.type]++; if (b.type !== 'U') counts.total++; }
    const res = { fs, beats, quality, rhythm, times, avgCount: avg ? avg.count : 0, counts };
    res.findings = summarize(res);
    res.level = res.findings.some(x => x.level === 'warn') ? 'warn'
      : res.findings.some(x => x.level === 'info') ? 'info' : 'ok';
    res.headline = { ok: 'Unauffällig', info: 'Überwiegend unauffällig – Hinweise beachten', warn: 'Auffälligkeiten gefunden' }[res.level];
    return res;
  }

  const TYPE_NAMES = { S: 'SVES', V: 'VES', A: 'abweichend', U: 'gestört', N: 'normal' };

  global.EkgAnalysis = { analyze, TYPE_NAMES };
})(window);
