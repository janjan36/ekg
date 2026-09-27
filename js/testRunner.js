/* Ablaufsteuerung der geführten Messungen: Phasen, Atemtakt-Kreis, Signaltöne, Erkennung des Aufstehens,
 * Live-Werte. Die Aufnahme selbst übernimmt app.js über die übergebene Schnittstelle (api). */
(function (global) {
  'use strict';

  const $ = id => document.getElementById(id);

  class TestRunner {
    /* api: {
     *   isConnected(), source(), startRecording(opts), stopRecording(opts), recTime(), addEvent(ev),
     *   gravity(), postureState(), liveBeats(), settings
     * } */
    constructor(api) {
      this.api = api;
      this.running = false;
      this.chart = new global.Charts2.EventHrChart($('runChart'));
      $('btnTestCancel').onclick = () => this.cancel();
      this._frame = this._frame.bind(this);
    }

    // Kurzer Ton über Web Audio (auf dem iPhone erst nach einer Berührung möglich – Start-Knopf genügt)
    beep(freq = 880, ms = 180, times = 1) {
      try {
        if (!this.audio) this.audio = new (global.AudioContext || global.webkitAudioContext)();
        this.audio.resume();
        for (let i = 0; i < times; i++) {
          const t = this.audio.currentTime + i * (ms / 1000 + 0.08);
          const o = this.audio.createOscillator(), g = this.audio.createGain();
          o.frequency.value = freq;
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
          o.connect(g).connect(this.audio.destination);
          o.start(t); o.stop(t + ms / 1000 + 0.02);
        }
      } catch (_) { /* ohne Ton weiter */ }
      if (navigator.vibrate && navigator.userActivation && navigator.userActivation.hasBeenActive) navigator.vibrate(200);
    }

    start(type, opts = {}) {
      if (this.running) return;
      if (!this.api.isConnected()) {
        alert('Bitte zuerst den Gurt verbinden – oder „Demo“ wählen.');
        return;
      }
      const proto = global.Tests.protocol(type, opts);
      this.proto = proto;
      this.total = proto.phases.reduce((s, p) => s + p.dur, 0);
      this.beep(660, 60);   // Audio freischalten (Nutzeraktion)
      const ok = this.api.startRecording({
        maxSeconds: this.total + 3,
        test: { type, params: proto.params || {}, age: opts.age || null }
      });
      if (!ok) return;
      this.running = true;
      this.standFound = false;
      this.detector = null;
      $('testMenu').hidden = true;
      $('testRun').hidden = false;
      $('runName').textContent = proto.name;
      $('runCohTile').hidden = !proto.phases.some(p => p.pacer);
      this.t0 = performance.now();
      this.idx = -1;
      this.lastUi = 0;
      this._nextPhase();
      requestAnimationFrame(this._frame);
    }

    get elapsed() { return (performance.now() - this.t0) / 1000; }

    _nextPhase() {
      this.idx++;
      const src = this.api.source();
      if (this.idx >= this.proto.phases.length) return this._finish();
      const ph = this.proto.phases[this.idx];
      // Sollzeit statt tatsächlicher Frame-Zeit, damit Phasen- und Gesamtzeit zusammenpassen
      ph.start = this.proto.phases.slice(0, this.idx).reduce((s, p) => s + p.dur, 0);
      if (ph.event) this.api.addEvent({ id: ph.event, value: ph.value });
      if (ph.alert) this.beep(880, 200, 2);
      $('runTitle').textContent = ph.title;
      $('runText').textContent = ph.text;
      $('pacerWrap').hidden = !ph.pacer;
      if (ph.detectStand) {
        this.detector = new global.Posture.ChangeDetector(this.api.gravity(), 45, 1.5);
        if (!this.api.gravity()) $('runText').textContent += ' (Lagesensor nicht verfügbar – Zeitpunkt der Aufforderung zählt.)';
      }
      // Demo-Gurt spielt das passende Verhalten vor
      if (src && src.setBreathing) {
        if (ph.pacer) src.setBreathing(60 / ph.pacer.rate, 1.6); else src.setBreathing(4.5, 1);
        if (ph.detectStand) setTimeout(() => this.running && src.standUp(), 2500);
      }
    }

    _frame() {
      if (!this.running) return;
      const el = this.elapsed;
      const ph = this.proto.phases[this.idx];
      if (el - ph.start >= ph.dur) { this._nextPhase(); if (!this.running) return; }
      const cur = this.proto.phases[this.idx];
      const pe = el - cur.start;

      $('runProgress').style.width = Math.min(100, 100 * el / this.total) + '%';
      const left = Math.max(0, cur.dur - pe), all = Math.max(0, this.total - el);
      $('runTime').textContent = `Phase noch ${fmt(left)} · gesamt noch ${fmt(all)}`;

      if (cur.pacer) {
        const st = global.Tests.pacerState(pe, cur.pacer);
        $('pacer').style.transform = `scale(${0.35 + 0.65 * st.level})`;
        $('pacerText').textContent = `${st.inhale ? 'Einatmen' : 'Ausatmen'} · ${Math.ceil(st.secsLeft)}`;
        $('pacerWrap').dataset.phase = st.inhale ? 'in' : 'out';
      }

      // Aufstehen über den Lagesensor erkennen
      if (this.detector && !this.standFound) {
        const since = this.detector.update(this.api.gravity(), el);
        if (since != null) {
          this.standFound = true;
          this.api.addEvent({ id: 'standDetected', t: this.api.recTime() - (el - since) });
          $('runText').textContent = 'Aufstehen erkannt ✓ – jetzt ruhig stehen bleiben.';
        }
      }

      if (el - this.lastUi >= 1) { this.lastUi = el; this._updateValues(el, cur); }
      requestAnimationFrame(this._frame);
    }

    _updateValues(el, cur) {
      const wall0 = Date.now() / 1000 - el;   // Wanduhrzeit des Teststarts
      const raw = this.api.liveBeats();
      const valid = global.Hrv.validateRR(raw.map(b => b.rr));   // Extraschläge/Artefakte ausblenden
      const beats = raw.filter((_, i) => valid[i]).map(b => ({ t: b.t - wall0, rr: b.rr, hr: 60000 / b.rr }));
      const lastHr = beats.slice(-3).map(b => b.hr).sort((a, b) => a - b)[1] || (beats.length ? beats[beats.length - 1].hr : null);
      $('runHr').textContent = lastHr ? Math.round(lastHr) : '–';
      const recent = beats.filter(b => b.t > el - 90);
      this.chart.setData(recent, [], [Math.max(0, el - 90), Math.max(90, el)],
        cur.pacer ? { start: cur.start, rate: cur.pacer.rate, inhale: cur.pacer.inhale } : null);
      if (cur.pacer) {
        const c = global.HrvX.coherence(beats.filter(b => b.t > el - 64));
        $('runCoh').textContent = c ? Math.round(c.score) : '–';
        $('runCohLevel').textContent = c ? `% · ${c.score >= 60 ? 'hoch' : c.score >= 30 ? 'mittel' : 'niedrig'}` : '% · ab ca. 30 s';
      }
      const ps = this.api.postureState();
      $('runPosture').textContent = ps ? ps.posture : '–';
      $('runMotion').textContent = ps ? ps.motion : ' ';
    }

    _reset() {
      this.running = false;
      $('testMenu').hidden = false;
      $('testRun').hidden = true;
      const src = this.api.source();
      if (src && src.setBreathing) { src.setBreathing(4.5, 1); src.lieDown(); }
    }

    async _finish() {
      this._reset();
      this.beep(990, 150, 3);
      await this.api.stopRecording({});
    }

    async cancel() {
      if (!this.running) return;
      if (!confirm('Test abbrechen? Die bisherige Messung wird verworfen.')) return;
      this._reset();
      await this.api.stopRecording({ discard: true });
    }

    // Verbindung verloren: Test beenden, Daten behalten
    abort() {
      if (this.running) this._reset();
    }
  }

  function fmt(s) {
    const t = Math.ceil(s);
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  }

  global.TestRunner = TestRunner;
})(window);
