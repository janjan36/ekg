/* Erweiterte HRV aus RR-Intervallen:
 *  - Frequenzbereich (Welch-Spektrum, 4 Hz interpoliert): LF, HF, LF/HF
 *  - Poincaré (SD1, SD2), Stress-Index nach Baevsky (Wurzel, wie Kubios)
 *  - DFA α1 (4–16 Schläge) und α2 (16–64 Schläge) */
(function (global) {
  'use strict';

  const RESAMPLE_HZ = 4;
  const BANDS = { vlf: [0.0033, 0.04], lf: [0.04, 0.15], hf: [0.15, 0.4] };

  /* ---------- Grundlagen ---------- */
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2;
          const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
          [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
        }
      }
    }
  }

  const mean = v => v.reduce((a, b) => a + b, 0) / v.length;
  const variance = v => { const m = mean(v); return v.reduce((a, x) => a + (x - m) ** 2, 0) / (v.length - 1); };
  const nextPow2 = n => 2 ** Math.ceil(Math.log2(Math.max(2, n)));

  // Gültige Intervalle (Artefakte/Extraschläge raus) mit ihrer Zeit (s, Ende des Intervalls)
  function cleanSeries(rr, rrT) {
    const valid = global.Hrv.validateRR(Array.from(rr));
    const t = [], nn = [];
    let acc = 0;
    for (let i = 0; i < rr.length; i++) {
      acc += rr[i] / 1000;
      if (valid[i]) { t.push(rrT ? rrT[i] : acc); nn.push(rr[i]); }
    }
    return { t, nn, valid };
  }

  // Gleichmäßige Abtastung per natürlichem kubischem Spline (lineare Interpolation würde das
  // HF-Band merklich dämpfen – bei 1 Schlag/s und 0,25 Hz um etwa ein Drittel)
  function resample(t, v, fs) {
    const m = t.length;
    const h = new Float64Array(m - 1);
    for (let i = 0; i < m - 1; i++) h[i] = (t[i + 1] - t[i]) || 1e-6;
    // Tridiagonales System für die zweiten Ableitungen (Thomas-Algorithmus)
    const M = new Float64Array(m), cp = new Float64Array(m), dp = new Float64Array(m);
    for (let i = 1; i < m - 1; i++) {
      const a = h[i - 1], b = 2 * (h[i - 1] + h[i]), c = h[i];
      const d = 6 * ((v[i + 1] - v[i]) / h[i] - (v[i] - v[i - 1]) / h[i - 1]);
      const den = b - a * cp[i - 1];
      cp[i] = c / den;
      dp[i] = (d - a * dp[i - 1]) / den;
    }
    for (let i = m - 2; i >= 1; i--) M[i] = dp[i] - cp[i] * M[i + 1];

    const n = Math.floor((t[m - 1] - t[0]) * fs) + 1;
    const out = new Float64Array(Math.max(0, n));
    let j = 0;
    for (let i = 0; i < n; i++) {
      const x = t[0] + i / fs;
      while (j < m - 2 && t[j + 1] < x) j++;
      const A = (t[j + 1] - x) / h[j], B = (x - t[j]) / h[j];
      out[i] = A * v[j] + B * v[j + 1] + ((A ** 3 - A) * M[j] + (B ** 3 - B) * M[j + 1]) * h[j] * h[j] / 6;
    }
    return out;
  }

  // Leistungsdichte (ms²/Hz) nach Welch: Hann-Fenster, 50 % Überlappung, lineare Trendbereinigung
  function welch(x, fs, segLen) {
    segLen = Math.min(segLen, x.length);
    const nfft = Math.max(1024, nextPow2(segLen));
    const step = Math.max(1, Math.floor(segLen / 2));
    const win = Float64Array.from({ length: segLen }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (segLen - 1)));
    const u = win.reduce((a, w) => a + w * w, 0);
    const psd = new Float64Array(nfft / 2 + 1);
    let segs = 0;
    for (let s = 0; s + segLen <= x.length; s += step) {
      const seg = x.subarray(s, s + segLen);
      // lineare Regression entfernen
      const n = segLen, mx = (n - 1) / 2, my = mean(Array.from(seg));
      let sxy = 0, sxx = 0;
      for (let i = 0; i < n; i++) { sxy += (i - mx) * (seg[i] - my); sxx += (i - mx) ** 2; }
      const b = sxy / sxx;
      const re = new Float64Array(nfft), im = new Float64Array(nfft);
      for (let i = 0; i < n; i++) re[i] = (seg[i] - my - b * (i - mx)) * win[i];
      fft(re, im);
      for (let k = 0; k <= nfft / 2; k++) {
        const p = (re[k] ** 2 + im[k] ** 2) / (fs * u);
        psd[k] += k === 0 || k === nfft / 2 ? p : 2 * p;
      }
      segs++;
    }
    for (let k = 0; k < psd.length; k++) psd[k] /= Math.max(1, segs);
    return { f: Float64Array.from({ length: psd.length }, (_, k) => k * fs / nfft), p: psd, df: fs / nfft };
  }

  function bandPower(spec, lo, hi) {
    let s = 0;
    for (let k = 0; k < spec.f.length; k++) if (spec.f[k] >= lo && spec.f[k] < hi) s += spec.p[k] * spec.df;
    return s;
  }

  function peakIn(spec, lo, hi) {
    let best = -1;
    for (let k = 0; k < spec.f.length; k++) {
      if (spec.f[k] >= lo && spec.f[k] < hi && (best < 0 || spec.p[k] > spec.p[best])) best = k;
    }
    return best < 0 ? null : spec.f[best];
  }

  /* ---------- Frequenzbereich ---------- */
  function frequency(rr, rrT) {
    const { t, nn } = cleanSeries(rr, rrT);
    if (nn.length < 30) return null;
    const duration = t[t.length - 1] - t[0];
    if (duration < 60) return null;
    const x = resample(t, nn, RESAMPLE_HZ);
    const spec = welch(x, RESAMPLE_HZ, 256);   // 64-s-Fenster
    const lf = bandPower(spec, ...BANDS.lf), hf = bandPower(spec, ...BANDS.hf);
    // Kein VLF: laut Task Force (1996) aus Messungen ≤ 5 min „fragwürdig, zu vermeiden“.
    // LF braucht mindestens 2 min, HF mindestens 1 min.
    return {
      spec, duration,
      lf, hf,
      total: lf + hf,
      lfhf: hf > 0 ? lf / hf : null,
      lfnu: 100 * lf / (lf + hf), hfnu: 100 * hf / (lf + hf),
      lfPeak: peakIn(spec, ...BANDS.lf), hfPeak: peakIn(spec, ...BANDS.hf),
      lfReliable: duration >= 120
    };
  }

  /* ---------- Poincaré und Stress-Index ---------- */
  function poincare(rr) {
    const { nn, valid } = cleanSeries(rr);
    const pairs = [];
    for (let i = 1; i < rr.length; i++) if (valid[i] && valid[i - 1]) pairs.push([rr[i - 1], rr[i]]);
    if (pairs.length < 10) return null;
    const d = pairs.map(([a, b]) => b - a);
    const vd = variance(d), vnn = variance(nn);
    const sd1 = Math.sqrt(vd / 2);
    const sd2 = Math.sqrt(Math.max(0, 2 * vnn - vd / 2));
    return { pairs, sd1, sd2, ratio: sd2 > 0 ? sd1 / sd2 : null, meanRR: mean(nn) };
  }

  function stressIndex(rr) {
    const { nn } = cleanSeries(rr);
    if (nn.length < 30) return null;
    const bin = 50;
    const counts = new Map();
    for (const v of nn) { const k = Math.floor(v / bin); counts.set(k, (counts.get(k) || 0) + 1); }
    let modeK = null, modeN = 0;
    for (const [k, n] of counts) if (n > modeN) { modeN = n; modeK = k; }
    const mo = (modeK + 0.5) * bin / 1000;
    const amo = 100 * modeN / nn.length;
    const mxdmn = (Math.max(...nn) - Math.min(...nn)) / 1000;
    if (!mxdmn) return null;
    return Math.sqrt(amo / (2 * mo * mxdmn));
  }

  /* ---------- DFA ---------- */
  function dfa(nn, nMin, nMax) {
    const N = nn.length;
    if (N < nMax * 2 || N < 30) return null;
    const m = mean(nn);
    const y = new Float64Array(N);
    let acc = 0;
    for (let i = 0; i < N; i++) { acc += nn[i] - m; y[i] = acc; }
    const logs = [];
    for (let n = nMin; n <= nMax; n++) {
      const boxes = Math.floor(N / n);
      if (boxes < 2) continue;
      let sum = 0;
      // Boxen von vorne und von hinten, damit kein Rest ungenutzt bleibt
      for (const fromEnd of [false, true]) {
        for (let b = 0; b < boxes; b++) {
          const start = fromEnd ? N - (b + 1) * n : b * n;
          const mx = (n - 1) / 2;
          let my = 0;
          for (let i = 0; i < n; i++) my += y[start + i];
          my /= n;
          let sxy = 0, sxx = 0;
          for (let i = 0; i < n; i++) { sxy += (i - mx) * (y[start + i] - my); sxx += (i - mx) ** 2; }
          const slope = sxy / sxx;
          for (let i = 0; i < n; i++) sum += (y[start + i] - (my + slope * (i - mx))) ** 2;
        }
      }
      logs.push([Math.log10(n), Math.log10(Math.sqrt(sum / (2 * boxes * n)))]);
    }
    if (logs.length < 3) return null;
    const mxl = mean(logs.map(l => l[0])), myl = mean(logs.map(l => l[1]));
    let sxy = 0, sxx = 0;
    for (const [lx, ly] of logs) { sxy += (lx - mxl) * (ly - myl); sxx += (lx - mxl) ** 2; }
    return sxy / sxx;
  }

  function dfaOf(rr) {
    const { nn } = cleanSeries(rr);
    return { a1: dfa(nn, 4, 16), a2: nn.length >= 200 ? dfa(nn, 16, 64) : null, beats: nn.length };
  }

  // Einordnung von DFA α1 bei Belastung (Rogers/Gronwald): 0,75 ≈ aerobe, 0,5 ≈ anaerobe Schwelle
  function dfaZone(a1) {
    if (a1 == null) return null;
    if (a1 > 1.0) return { code: 'rest', text: 'Ruhe/sehr leicht (korreliert)' };
    if (a1 >= 0.75) return { code: 'z1', text: 'unter aerober Schwelle' };
    if (a1 >= 0.5) return { code: 'z2', text: 'zwischen aerober und anaerober Schwelle' };
    return { code: 'z3', text: 'über anaerober Schwelle' };
  }

  global.HrvX = { frequency, poincare, stressIndex, dfaOf, dfa, dfaZone, cleanSeries, BANDS };
})(window);
