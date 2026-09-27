/* Atemfrequenz aus dem Beschleunigungssensor (Brustkorbbewegung).
 * Ablauf: jede Achse bandpassfiltern (0,08–0,7 Hz ≈ 5–42 Atemzüge/min), auf 5 Hz reduzieren,
 * auf die Hauptbewegungsrichtung projizieren (Hauptkomponente), Atemzüge als Maxima mit Hysterese zählen. */
(function (global) {
  'use strict';

  const { Biquad } = global.EkgFilters;
  const OUT_FS = 5;
  const HP_HZ = 0.08;
  const LP_HZ = 0.7;
  const MIN_BREATH_S = 1.4;
  const MAX_BREATH_S = 15;
  const LIVE_WINDOW_S = 30;

  function median(v) {
    const s = Array.from(v).sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  // Robuste Streuung (MAD), damit einzelne Bewegungsartefakte die Schwelle nicht hochtreiben.
  function robustSd(s) {
    const med = median(s);
    return 1.4826 * median(Array.from(s, v => Math.abs(v - med)));
  }

  function makeChain(fs) {
    const hp = Biquad.highpass(fs, HP_HZ), lp = Biquad.lowpass(fs, LP_HZ);
    return x => lp.process(hp.process(x));
  }

  // Hauptachse der 3D-Bewegung per Potenzmethode auf der Kovarianzmatrix.
  function principalAxis(xs, ys, zs, prev) {
    const n = xs.length;
    const mean = a => a.reduce((s, v) => s + v, 0) / n;
    const mx = mean(xs), my = mean(ys), mz = mean(zs);
    const c = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < n; i++) {
      const d = [xs[i] - mx, ys[i] - my, zs[i] - mz];
      for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) c[r][k] += d[r] * d[k];
    }
    let v = prev ? prev.slice() : [0.3, 0.4, 0.85];
    for (let it = 0; it < 40; it++) {
      const w = [0, 1, 2].map(r => c[r][0] * v[0] + c[r][1] * v[1] + c[r][2] * v[2]);
      const len = Math.hypot(w[0], w[1], w[2]);
      if (!len) break;
      v = w.map(x => x / len);
    }
    // Vorzeichen stabil halten, damit die Kurve live nicht umklappt
    if (prev && v[0] * prev[0] + v[1] * prev[1] + v[2] * prev[2] < 0) v = v.map(x => -x);
    return v;
  }

  function project(xs, ys, zs, v) {
    const out = new Float32Array(xs.length);
    for (let i = 0; i < xs.length; i++) out[i] = xs[i] * v[0] + ys[i] * v[1] + zs[i] * v[2];
    return out;
  }

  // Ein Atemzug = Maximum oberhalb +h, bestätigt sobald das Signal wieder unter −h fällt.
  function detectBreaths(s, fs) {
    const sd = robustSd(s);
    if (!(sd > 0.2)) return [];              // praktisch keine Bewegung
    const h = 0.35 * sd;
    const peaks = [];
    let high = false, maxIdx = -1;
    for (let i = 0; i < s.length; i++) {
      if (s[i] > h) {
        if (!high) { high = true; maxIdx = i; } else if (s[i] > s[maxIdx]) maxIdx = i;
      } else if (s[i] < -h) {
        if (high) peaks.push(maxIdx);
        high = false;
      }
    }
    // Zu dicht aufeinanderfolgende Maxima zusammenfassen
    const minGap = MIN_BREATH_S * fs;
    const out = [];
    for (const p of peaks) {
      const last = out[out.length - 1];
      if (last !== undefined && p - last < minGap) {
        if (s[p] > s[last]) out[out.length - 1] = p;
      } else out.push(p);
    }
    return out;
  }

  function rateFromPeaks(peaks, fs) {
    const iv = [];
    for (let i = 1; i < peaks.length; i++) {
      const d = (peaks[i] - peaks[i - 1]) / fs;
      if (d >= MIN_BREATH_S && d <= MAX_BREATH_S) iv.push(d);
    }
    return iv.length >= 2 ? 60 / median(iv) : null;
  }

  /* ---------- Live ---------- */
  class LiveRespiration {
    constructor(accFs) {
      this.accFs = accFs;
      this.dec = Math.max(1, Math.round(accFs / OUT_FS));
      this.fs = accFs / this.dec;
      this.chains = [makeChain(accFs), makeChain(accFs), makeChain(accFs)];
      this.k = 0;
      this.xs = []; this.ys = []; this.zs = [];
      this.axis = null;
      this.maxLen = Math.round(LIVE_WINDOW_S * this.fs);
    }

    // xyz: verschachtelt [x0,y0,z0,x1,…] in mG
    push(xyz) {
      for (let i = 0; i + 2 < xyz.length; i += 3) {
        const fx = this.chains[0](xyz[i]), fy = this.chains[1](xyz[i + 1]), fz = this.chains[2](xyz[i + 2]);
        if (++this.k % this.dec) continue;
        this.xs.push(fx); this.ys.push(fy); this.zs.push(fz);
      }
      const extra = this.xs.length - this.maxLen;
      if (extra > 0) { this.xs.splice(0, extra); this.ys.splice(0, extra); this.zs.splice(0, extra); }
    }

    result() {
      if (this.xs.length < 8 * this.fs) return { fs: this.fs, signal: new Float32Array(0), peaks: [], rate: null };
      this.axis = principalAxis(this.xs, this.ys, this.zs, this.axis);
      const signal = project(this.xs, this.ys, this.zs, this.axis);
      const peaks = detectBreaths(signal, this.fs);
      const rate = this.xs.length >= 15 * this.fs ? rateFromPeaks(peaks, this.fs) : null;
      return { fs: this.fs, signal, peaks, rate, windowS: LIVE_WINDOW_S };
    }
  }

  /* ---------- Gespeicherte Aufnahme (phasenfrei gefiltert) ---------- */
  function filtfiltAxis(values, fs) {
    const out = new Float32Array(values.length);
    let f = makeChain(fs);
    for (let i = 0; i < values.length; i++) out[i] = f(values[i]);
    f = makeChain(fs);
    for (let i = values.length - 1; i >= 0; i--) out[i] = f(out[i]);
    return out;
  }

  function analyze(acc, accFs) {
    if (!acc || !accFs || acc.length < 3 * accFs * 10) return null;
    const n = Math.floor(acc.length / 3);
    const axes = [0, 1, 2].map(c => {
      const a = new Float32Array(n);
      for (let i = 0; i < n; i++) a[i] = acc[i * 3 + c];
      return filtfiltAxis(a, accFs);
    });
    const dec = Math.max(1, Math.round(accFs / OUT_FS));
    const fs = accFs / dec;
    const [xs, ys, zs] = axes.map(a => Array.from({ length: Math.floor(n / dec) }, (_, i) => a[i * dec]));
    const signal = project(xs, ys, zs, principalAxis(xs, ys, zs, null));
    const peaks = detectBreaths(signal, fs);
    return { fs, signal, peaks, rate: rateFromPeaks(peaks, fs), breaths: peaks.length };
  }

  global.Resp = { LiveRespiration, analyze };
})(window);
