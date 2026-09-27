/* Anzeige-Filter für das EKG (Biquads nach RBJ Audio-EQ-Cookbook).
 * Die gespeicherten Rohdaten werden nie gefiltert – nur die Darstellung. */
(function (global) {
  'use strict';

  class Biquad {
    constructor(b0, b1, b2, a0, a1, a2) {
      this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
      this.a1 = a1 / a0; this.a2 = a2 / a0;
      this.primed = false;
      this.x1 = this.x2 = this.y1 = this.y2 = 0;
    }

    static highpass(fs, f0, q = Math.SQRT1_2) {
      const w0 = 2 * Math.PI * f0 / fs, c = Math.cos(w0), alpha = Math.sin(w0) / (2 * q);
      return new Biquad((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + alpha, -2 * c, 1 - alpha);
    }

    static lowpass(fs, f0, q = Math.SQRT1_2) {
      const w0 = 2 * Math.PI * f0 / fs, c = Math.cos(w0), alpha = Math.sin(w0) / (2 * q);
      return new Biquad((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + alpha, -2 * c, 1 - alpha);
    }

    static notch(fs, f0, q) {
      const w0 = 2 * Math.PI * f0 / fs, c = Math.cos(w0), alpha = Math.sin(w0) / (2 * q);
      return new Biquad(1, -2 * c, 1, 1 + alpha, -2 * c, 1 - alpha);
    }

    // Zustand auf den eingeschwungenen Wert für ein konstantes Signal x setzen,
    // damit ein DC-Offset am Anfang keinen großen Einschwing-Ausschlag erzeugt.
    prime(x) {
      const dcGain = (this.b0 + this.b1 + this.b2) / (1 + this.a1 + this.a2);
      this.x1 = this.x2 = x;
      this.y1 = this.y2 = dcGain * x;
      this.primed = true;
    }

    process(x) {
      if (!this.primed) this.prime(x);
      const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1; this.x1 = x;
      this.y2 = this.y1; this.y1 = y;
      return y;
    }
  }

  class FilterChain {
    constructor(fs, opts) {
      this.stages = [];
      if (opts.highpass) this.stages.push(Biquad.highpass(fs, 0.5));
      if (opts.notch) this.stages.push(Biquad.notch(fs, 50, 8));
    }

    process(x) {
      for (const s of this.stages) x = s.process(x);
      return x;
    }
  }

  // Vorwärts-rückwärts-Filterung (phasenfrei) für die Ansicht gespeicherter Aufnahmen.
  function filtfilt(samples, fs, opts) {
    const n = samples.length;
    const out = new Float32Array(n);
    if (!opts.highpass && !opts.notch) {
      out.set(samples);
      return out;
    }
    let chain = new FilterChain(fs, opts);
    for (let i = 0; i < n; i++) out[i] = chain.process(samples[i]);
    chain = new FilterChain(fs, opts);
    for (let i = n - 1; i >= 0; i--) out[i] = chain.process(out[i]);
    return out;
  }

  global.EkgFilters = { Biquad, FilterChain, filtfilt };
})(window);
