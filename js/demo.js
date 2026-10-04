/* Simulierter Brustgurt zum Testen ohne Polar H10.
 * Liefert synthetisches EKG (130 Hz, µV) in Paketen wie der echte Gurt, dazu HF/RR und Akku.
 * Gleiche Handler-Schnittstelle wie PolarH10Source. */
(function (global) {
  'use strict';

  const FS = 130;
  const FRAME = 73;              // Samples pro Paket, wie beim H10
  const BASE_HR = 64;
  const BREATH_PERIOD = 4.5;     // s  (≈ 13 Atemzüge/min) – für die atemabhängige Schwankung
  const RSA = 0.06;              // ±6 % RR-Schwankung

  // EKG-Wellen relativ zur R-Zacke: [Versatz s, Amplitude µV, Breite s]
  const QRST = [
    [-0.035, -110, 0.010], // Q
    [0.000, 1150, 0.011],  // R
    [0.035, -280, 0.012],  // S
    [0.26, 320, 0.045]     // T
  ];
  const WAVES = {
    N: [[-0.20, 140, 0.025], ...QRST],
    S: [[-0.15, 90, 0.022], ...QRST],                                   // vorzeitig, andere P-Welle
    V: [[0.0, 900, 0.03], [0.07, -700, 0.035], [0.30, -380, 0.07]]      // breit, ohne P, T gegensinnig
  };
  // Zum Vorführen der Auswertung: gelegentliche Extraschläge und eine kurze Bewegungsstörung
  const SVES_EVERY = 17, VES_EVERY = 29;
  const ARTEFACT_PERIOD = 45, ARTEFACT_START = 30, ARTEFACT_LEN = 2.5;

  function gaussNoise() {
    return Math.sqrt(-2 * Math.log(Math.random() || 1e-9)) * Math.cos(2 * Math.PI * Math.random());
  }

  class DemoSource {
    constructor(handlers) {
      this.h = handlers;
      this.fs = FS;
      this.name = 'Demo-Gurt';
      this._timers = [];
    }

    async connect() {
      this.h.onStatus('Demo startet …');
      this.t = 0;               // Zeit des nächsten Samples (s)
      this.beats = [];          // R-Zacken { t (s), kind: N|S|V }
      this.pendingRR = [];      // seit letzter HF-Meldung vollendete RR-Intervalle
      this._nextBeat = 0.4;
      this._nextKind = 'N';
      this._beatNo = 0;
      this._compensate = 0;
      this._scheduleBeats(5);
      this.h.onBattery(87);
      this.h.onStatus(`Verbunden: ${this.name}`);

      this._timers.push(setInterval(() => this._emitEcg(), FRAME / FS * 1000));
      this._timers.push(setInterval(() => this._emitHr(), 1000));
    }

    async disconnect() {
      this._timers.forEach(clearInterval);
      this._timers = [];
      this.h.onDisconnect({ manual: true });
    }

    async reconnect() { return false; }

    _scheduleBeats(untilT) {
      while (this._nextBeat < untilT) {
        const last = this.beats.length ? this.beats[this.beats.length - 1] : null;
        this.beats.push({ t: this._nextBeat, kind: this._nextKind });
        if (last !== null) this.pendingRR.push({ at: this._nextBeat, rr: (this._nextBeat - last.t) * 1000 });
        // Respiratorische Sinusarrhythmie + etwas Zufall
        const base = 60 / BASE_HR * (1 + RSA * Math.sin(2 * Math.PI * this._nextBeat / BREATH_PERIOD)) + 0.015 * gaussNoise();
        let rr = base, kind = 'N';
        this._beatNo++;
        if (this._beatNo % VES_EVERY === 0) {
          kind = 'V'; rr = base * 0.62; this._compensate = 2 * base - rr;   // mit kompensatorischer Pause
        } else if (this._beatNo % SVES_EVERY === 0) {
          kind = 'S'; rr = base * 0.7;
        } else if (this._compensate) {
          rr = this._compensate; this._compensate = 0;
        }
        this._nextBeat += rr;
        this._nextKind = kind;
      }
      while (this.beats.length > 4 && this.beats[1].t < this.t - 1) this.beats.shift();
    }

    _sample(t) {
      let v = 0;
      for (const b of this.beats) {
        const dt = t - b.t;
        if (dt < -0.4 || dt > 0.6) continue;
        for (const [off, amp, w] of WAVES[b.kind]) v += amp * Math.exp(-((dt - off) ** 2) / (2 * w * w));
      }
      v += 120 * Math.sin(2 * Math.PI * 0.22 * t);   // Grundlinienschwankung (Atmung)
      v += 18 * Math.sin(2 * Math.PI * 50 * t);      // Netzbrummen
      v += 12 * gaussNoise();
      const ta = t % ARTEFACT_PERIOD;
      if (ta >= ARTEFACT_START && ta < ARTEFACT_START + ARTEFACT_LEN) {
        v += 900 * Math.sin(2 * Math.PI * 1.3 * t) + 220 * gaussNoise();  // Bewegung/Muskelzittern
      }
      return Math.round(v);
    }

    _emitEcg() {
      const samples = new Int32Array(FRAME);
      this._scheduleBeats(this.t + FRAME / FS + 1);
      for (let i = 0; i < FRAME; i++) {
        samples[i] = this._sample(this.t);
        this.t += 1 / FS;
      }
      this.h.onEcg(samples, { lost: 0 });
    }

    _emitHr() {
      // Nur bereits vergangene Schläge melden
      const n = this.pendingRR.findIndex(p => p.at > this.t);
      const done = this.pendingRR.splice(0, n < 0 ? this.pendingRR.length : n).map(p => p.rr);
      const lastRR = done.length ? done[done.length - 1] : 60000 / BASE_HR;
      this.h.onHr({ hr: Math.round(60000 / lastRR), rr: done, contact: true });
    }
  }

  global.DemoSource = DemoSource;
})(window);
