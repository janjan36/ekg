/* Körperlage und Bewegung aus dem Beschleunigungssensor (mG).
 * Lage: Richtung der Schwerkraft. Ohne Kalibrierung gilt „liegend“, wenn die Schwerkraft überwiegend
 * senkrecht zur Brust wirkt (Z-Achse, Rücken-/Bauchlage). Nach „Lage kalibrieren“ (aufrecht) wird der
 * Winkel zur gespeicherten Aufrecht-Richtung verwendet – dann werden auch Seitenlage und Zurücklehnen erkannt.
 * Bewegung: Streuung der Beschleunigung ohne Schwerkraftanteil. */
(function (global) {
  'use strict';

  const MOTION_LIGHT = 25;    // mG Effektivwert
  const MOTION_STRONG = 120;

  const norm = v => Math.hypot(v[0], v[1], v[2]) || 1;
  const angleDeg = (a, b) => {
    const c = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (norm(a) * norm(b));
    return Math.acos(Math.max(-1, Math.min(1, c))) * 180 / Math.PI;
  };

  // upright: kalibrierte Aufrecht-Richtung [x,y,z] oder null
  function classify(g, upright) {
    if (upright) {
      const a = angleDeg(g, upright);
      return a < 30 ? 'aufrecht' : a < 60 ? 'geneigt' : 'liegend';
    }
    const zShare = Math.abs(g[2]) / norm(g);
    return zShare > 0.75 ? 'liegend' : zShare > 0.45 ? 'geneigt' : 'aufrecht';
  }

  function motionLevel(rms) {
    return rms >= MOTION_STRONG ? 'starke Bewegung' : rms >= MOTION_LIGHT ? 'Bewegung' : 'ruhig';
  }

  /* ---------- Live ---------- */
  class PostureTracker {
    constructor(fs) {
      this.fs = fs;
      this.alpha = 1 - Math.exp(-2 * Math.PI * 0.3 / fs);   // Tiefpass 0,3 Hz für die Schwerkraft
      this.g = null;
      this.dyn = [];                                         // |a − g| der letzten 2 s
      this.win = Math.round(2 * fs);
      this.t = 0;                                            // Sekunden seit Start
    }

    push(xyz) {
      for (let i = 0; i + 2 < xyz.length; i += 3) {
        const a = [xyz[i], xyz[i + 1], xyz[i + 2]];
        if (!this.g) this.g = a.slice();
        for (let k = 0; k < 3; k++) this.g[k] += this.alpha * (a[k] - this.g[k]);
        this.dyn.push(Math.hypot(a[0] - this.g[0], a[1] - this.g[1], a[2] - this.g[2]));
        if (this.dyn.length > this.win) this.dyn.shift();
        this.t += 1 / this.fs;
      }
    }

    get gravity() { return this.g ? this.g.slice() : null; }

    state(upright) {
      if (!this.g || this.dyn.length < this.fs) return null;
      const rms = Math.sqrt(this.dyn.reduce((s, v) => s + v * v, 0) / this.dyn.length);
      return { posture: classify(this.g, upright), motion: motionLevel(rms), rms };
    }
  }

  // Erkennt eine deutliche Richtungsänderung (z. B. Aufstehen) gegenüber einer Referenz – achsenunabhängig
  class ChangeDetector {
    constructor(reference, thresholdDeg = 45, holdS = 1.5) {
      this.ref = reference;
      this.thr = thresholdDeg;
      this.hold = holdS;
      this.since = null;
    }

    // Gibt den Zeitpunkt (s) des Beginns zurück, sobald die Änderung lange genug anhält
    update(g, t) {
      if (!this.ref || !g) return null;
      if (angleDeg(g, this.ref) > this.thr) {
        if (this.since === null) this.since = t;
        if (t - this.since >= this.hold) return this.since;
      } else {
        this.since = null;
      }
      return null;
    }
  }

  /* ---------- Aufnahme ---------- */
  // acc: verschachtelt [x,y,z,…]; Ergebnis in 1-s-Abschnitten
  function analyze(acc, fs, upright) {
    if (!acc || !fs || acc.length < 3 * fs * 3) return null;
    const tr = new PostureTracker(fs);
    const seconds = [];
    const per = Math.round(fs) * 3;
    for (let s = 0; s + per <= acc.length; s += per) {
      tr.push(acc.subarray(s, s + per));
      const st = tr.state(upright);
      if (st) seconds.push({ t: tr.t, ...st, g: tr.gravity });
    }
    if (!seconds.length) return null;
    const share = (key, val) => 100 * seconds.filter(x => x[key] === val).length / seconds.length;
    const postures = ['liegend', 'geneigt', 'aufrecht'].map(p => [p, share('posture', p)]);
    const main = postures.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
    return {
      seconds,
      main,
      postures: Object.fromEntries(postures),
      motion: 100 - share('motion', 'ruhig'),
      strongMotion: share('motion', 'starke Bewegung')
    };
  }

  global.Posture = { PostureTracker, ChangeDetector, analyze, classify, angleDeg };
})(window);
