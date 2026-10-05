/* EKG-Darstellung auf Canvas: Millimeterpapier, Live-Sweep, scrollbare Aufnahme-Ansicht, HF-Verlauf. */
(function (global) {
  'use strict';

  const DEFAULT_PX_PER_MM = 96 / 25.4;

  function readColors() {
    const s = getComputedStyle(document.documentElement);
    const v = name => s.getPropertyValue(name).trim();
    return {
      paper: v('--ecg-paper'), minor: v('--ecg-grid-minor'), major: v('--ecg-grid-major'),
      trace: v('--ecg-trace'), label: v('--ecg-label'),
      tachoLine: v('--tacho-line'), tachoBad: v('--tacho-bad'), muted: v('--muted'),
      mark: { S: v('--mark-s'), V: v('--mark-v'), A: v('--mark-a') },
      markBad: v('--mark-bad'), markLine: v('--mark-line')
    };
  }

  // Buchstabe über einem auffälligen Schlag (S, V, A)
  function drawBeatTag(ctx, x, type, colors) {
    const color = colors.mark[type];
    if (!color) return;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.9;
    ctx.fillRect(x - 0.75, 20, 1.5, 8);
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.roundRect(x - 8, 3, 16, 16, 3);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(type, x, 15);
    ctx.textAlign = 'start';
  }

  // Farben neu lesen, wenn das System zwischen hell/dunkel wechselt.
  const themeListeners = [];
  global.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    themeListeners.forEach(fn => fn());
  });

  function setupCanvas(canvas, cssW, cssH) {
    const dpr = global.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  // Millimeterpapier; xOffsetPx verschiebt das Raster beim Scrollen mit.
  function drawGrid(ctx, w, h, pxPerMm, colors, xOffsetPx) {
    ctx.fillStyle = colors.paper;
    ctx.fillRect(0, 0, w, h);
    const midY = h / 2;
    const drawLines = (stepMm, color, width) => {
      const step = stepMm * pxPerMm;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (let x = -(xOffsetPx % step); x <= w; x += step) {
        const px = Math.round(x) + 0.5;
        ctx.moveTo(px, 0); ctx.lineTo(px, h);
      }
      const k0 = Math.floor(-midY / step), k1 = Math.ceil(midY / step);
      for (let k = k0; k <= k1; k++) {
        const py = Math.round(midY + k * step) + 0.5;
        ctx.moveTo(0, py); ctx.lineTo(w, py);
      }
      ctx.stroke();
    };
    if (pxPerMm >= 2.5) drawLines(1, colors.minor, 1);
    drawLines(5, colors.major, 1);
  }

  /* ---------- Live-Anzeige im Sweep-Modus (wie ein Monitor) ---------- */
  class LiveEcgChart {
    constructor(canvas, fs) {
      this.canvas = canvas;
      this.fs = fs;
      this.speed = 25;
      this.gain = 10;
      this.pxPerMm = DEFAULT_PX_PER_MM;
      this.colors = readColors();
      this.queue = [];
      this.qHead = 0;
      this.acc = 0;
      this.primed = false;
      this.lastTs = null;
      this.buf = new Float32Array(1).fill(NaN);
      this.writeIdx = 0;
      this.consumed = 0;        // Anzahl abgespielter Werte seit clear() – Bezug für Markierungen
      this.markers = [];        // [{ abs, type }]
      this.dirty = true;

      new ResizeObserver(() => this._resize()).observe(canvas.parentElement);
      themeListeners.push(() => { this.colors = readColors(); this._resize(); });
      this._frame = this._frame.bind(this);
      requestAnimationFrame(this._frame);
    }

    setScale({ speed, gain, pxPerMm }) {
      if (speed) this.speed = speed;
      if (gain) this.gain = gain;
      if (pxPerMm) this.pxPerMm = pxPerMm;
      this._resize();
    }

    push(values) {
      for (let i = 0; i < values.length; i++) this.queue.push(values[i]);
    }

    clear() {
      this.queue = [];
      this.qHead = 0;
      this.primed = false;
      this.buf.fill(NaN);
      this.writeIdx = 0;
      this.consumed = 0;
      this.markers = [];
      this.dirty = true;
    }

    setMarkers(markers) {
      this.markers = markers;
      this.dirty = true;
    }

    _resize() {
      const parent = this.canvas.parentElement;
      this.w = parent.clientWidth;
      this.h = parent.clientHeight;
      if (!this.w || !this.h) return;
      this.ctx = setupCanvas(this.canvas, this.w, this.h);
      this.pxPerSample = this.speed * this.pxPerMm / this.fs;
      this.buf = new Float32Array(Math.max(1, Math.floor(this.w / this.pxPerSample))).fill(NaN);
      this.writeIdx = 0;

      this.grid = document.createElement('canvas');
      drawGrid(setupCanvas(this.grid, this.w, this.h), this.w, this.h, this.pxPerMm, this.colors, 0);
      this.dirty = true;
    }

    _consume(n) {
      const len = this.buf.length;
      for (let i = 0; i < n; i++) {
        this.buf[this.writeIdx] = this.queue[this.qHead++];
        this.writeIdx = (this.writeIdx + 1) % len;
      }
      this.consumed += n;
      if (n) this.dirty = true;
      if (this.qHead > 8192) {
        this.queue = this.queue.slice(this.qHead);
        this.qHead = 0;
      }
    }

    // Der Gurt liefert ca. alle 0,56 s ein Paket. Für einen gleichmäßigen Lauf wird mit
    // ~0,6 s Puffer abgespielt und die Geschwindigkeit leicht nachgeregelt.
    _frame(ts) {
      requestAnimationFrame(this._frame);
      const dt = this.lastTs === null ? 0 : Math.min(0.25, (ts - this.lastTs) / 1000);
      this.lastTs = ts;
      const fs = this.fs;
      let pending = this.queue.length - this.qHead;

      if (!this.primed && pending >= fs * 0.6) this.primed = true;
      if (this.primed) {
        if (pending > fs * 2) {           // z. B. nach verstecktem Tab: aufholen
          this._consume(pending - Math.round(fs * 0.6));
          pending = this.queue.length - this.qHead;
        }
        const rate = pending > 1.2 * fs ? 1.08 : pending < 0.25 * fs ? 0.92 : 1;
        this.acc += dt * fs * rate;
        const n = Math.min(Math.floor(this.acc), pending);
        this.acc -= Math.floor(this.acc);
        this._consume(n);
        if (this.queue.length - this.qHead === 0) { this.primed = false; this.acc = 0; }
      }
      if (this.dirty && this.ctx) this._draw();
    }

    _draw() {
      this.dirty = false;
      const { ctx, w, h, buf } = this;
      ctx.drawImage(this.grid, 0, 0, w, h);
      const len = buf.length;
      const gap = Math.max(3, Math.round(this.fs * 0.08));
      const midY = h / 2;
      const scale = this.gain * this.pxPerMm / 1000;

      ctx.strokeStyle = this.colors.trace;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < len; i++) {
        const v = buf[i];
        if (Number.isNaN(v) || (i - this.writeIdx + len) % len < gap) { pen = false; continue; }
        const x = i * this.pxPerSample, y = midY - v * scale;
        if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
      }
      ctx.stroke();

      // Markierungen: Position über den Abstand zum zuletzt abgespielten Wert
      for (const m of this.markers) {
        const back = this.consumed - m.abs;
        if (back < 1 || back > len - gap) continue;
        drawBeatTag(ctx, ((this.writeIdx - back + len) % len) * this.pxPerSample, m.type, this.colors);
      }
    }
  }

  /* ---------- Scrollbare Ansicht einer gespeicherten Aufnahme ---------- */
  const CAL_MM = 10;

  // Eichzacke 1 mV, 200 ms breit, wie auf EKG-Papier; x0 = linker Rand des 10-mm-Bereichs
  function drawCalPulse(ctx, x0, midY, mm, scale, colors) {
    const top = midY - 1000 * scale;
    ctx.strokeStyle = colors.trace;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(x0 + 1 * mm, midY); ctx.lineTo(x0 + 2.5 * mm, midY); ctx.lineTo(x0 + 2.5 * mm, top);
    ctx.lineTo(x0 + 7.5 * mm, top); ctx.lineTo(x0 + 7.5 * mm, midY); ctx.lineTo(x0 + 9 * mm, midY);
    ctx.stroke();
    ctx.fillStyle = colors.label;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('1 mV', x0 + 5 * mm, top - 4);
    ctx.textAlign = 'start';
  }
  class ReviewEcgChart {
    constructor(scrollEl, innerEl, canvas, fs) {
      this.scrollEl = scrollEl;
      this.innerEl = innerEl;
      this.canvas = canvas;
      this.fs = fs;
      this.speed = 25;
      this.gain = 10;
      this.pxPerMm = DEFAULT_PX_PER_MM;
      this.data = new Float32Array(0);
      this.annotations = { beats: [], bad: [] };
      this.colors = readColors();
      this.onView = null;
      this._raf = 0;

      scrollEl.addEventListener('scroll', () => this._schedule());
      scrollEl.addEventListener('wheel', e => {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
          scrollEl.scrollLeft += e.deltaY;
          e.preventDefault();
        }
      }, { passive: false });
      new ResizeObserver(() => this.layout()).observe(scrollEl);
      themeListeners.push(() => { this.colors = readColors(); this.render(); });
    }

    get pxPerSecond() { return this.speed * this.pxPerMm; }
    // Platz links vor dem EKG für die 1-mV-Eichzacke
    get padPx() { return CAL_MM * this.pxPerMm; }
    get currentTime() { return (this.scrollEl.scrollLeft + this.w / 2 - this.padPx) / this.pxPerSecond; }

    setData(values) {
      this.data = values;
      this.layout();
      this.scrollEl.scrollLeft = 0;
      this.render();
    }

    // beats: [{ i (Sample), type }] – nur S/V/A werden beschriftet; bad: [{ start, end }] grau hinterlegt
    setAnnotations(annotations) {
      this.annotations = annotations || { beats: [], bad: [] };
      this.render();
    }

    setScale({ speed, gain, pxPerMm }) {
      const t = this.w ? this.currentTime : 0;
      if (speed) this.speed = speed;
      if (gain) this.gain = gain;
      if (pxPerMm) this.pxPerMm = pxPerMm;
      this.layout();
      this.scrollToTime(t);
    }

    scrollToTime(t) {
      this.scrollEl.scrollLeft = t * this.pxPerSecond + this.padPx - this.w / 2;
      this.render();
    }

    layout() {
      this.w = this.scrollEl.clientWidth;
      this.h = this.innerEl.clientHeight;
      if (!this.w || !this.h) return;
      const total = this.data.length / this.fs * this.pxPerSecond + this.padPx;
      this.innerEl.style.width = Math.max(this.w, Math.ceil(total)) + 'px';
      this.canvas.style.width = this.w + 'px';
      this.ctx = setupCanvas(this.canvas, this.w, this.h);
      this.render();
    }

    _schedule() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => { this._raf = 0; this.render(); });
    }

    render() {
      if (!this.ctx) return;
      const { ctx, w, h, data, fs } = this;
      const pad = this.padPx;
      const off = this.scrollEl.scrollLeft - pad;   // Bildschirm-x = Datenposition − off
      const pps = this.pxPerSecond / fs;
      const midY = h / 2;
      const scale = this.gain * this.pxPerMm / 1000;

      drawGrid(ctx, w, h, this.pxPerMm, this.colors, off + pad);
      if (off < 0) drawCalPulse(ctx, -off - pad, midY, this.pxPerMm, scale, this.colors);

      const i0 = Math.max(0, Math.floor(off / pps) - 1);
      const i1 = Math.min(data.length, Math.ceil((off + w) / pps) + 1);

      ctx.fillStyle = this.colors.markBad;
      for (const s of this.annotations.bad) {
        if (s.end < i0 || s.start > i1) continue;
        ctx.fillRect(s.start * pps - off, 0, (s.end - s.start) * pps, h);
      }
      ctx.strokeStyle = this.colors.trace;
      ctx.lineWidth = 1.4;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = i0; i < i1; i++) {
        const x = i * pps - off, y = midY - data[i] * scale;
        if (i === i0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();

      for (const b of this.annotations.beats) {
        if (b.i >= i0 && b.i <= i1) drawBeatTag(ctx, b.i * pps - off, b.type, this.colors);
      }

      // Sekundenmarken (unten, damit sie die Markierungen nicht verdecken)
      ctx.fillStyle = this.colors.label;
      ctx.font = '11px system-ui, sans-serif';
      const pxS = this.pxPerSecond;
      const every = pxS < 60 ? 5 : 1;
      for (let s = Math.max(0, Math.ceil(off / pxS / every) * every); s * pxS <= off + w; s += every) {
        ctx.fillText(`${s} s`, s * pxS - off + 3, h - 5);
      }

      if (this.onView) this.onView(off / pxS, (off + w) / pxS);
    }
  }

  /* ---------- Herzfrequenz-Verlauf (Tachogramm) ---------- */
  class Tachogram {
    constructor(canvas, onSeek) {
      this.canvas = canvas;
      this.colors = readColors();
      this.points = [];
      this.duration = 1;
      this.view = null;
      canvas.addEventListener('click', e => {
        const r = canvas.getBoundingClientRect();
        onSeek(this._tFromX(e.clientX - r.left));
      });
      new ResizeObserver(() => this.render()).observe(canvas.parentElement);
      themeListeners.push(() => { this.colors = readColors(); this.render(); });
    }

    setData(rrT, rr, valid, duration) {
      this.points = rr.map((v, i) => ({ t: rrT[i], hr: 60000 / v, ok: valid[i] }));
      this.duration = Math.max(1, duration);
      this.render();
    }

    setView(t0, t1) { this.view = [t0, t1]; this.render(); }

    _tFromX(x) { return (x - this.padL) / (this.w - this.padL - 6) * this.duration; }

    render() {
      const parent = this.canvas.parentElement;
      const w = this.w = parent.clientWidth, h = parent.clientHeight;
      if (!w || !h) return;
      const ctx = setupCanvas(this.canvas, w, h);
      const c = this.colors;
      this.padL = 34;
      const padT = 8, padB = 16, plotW = w - this.padL - 6, plotH = h - padT - padB;

      ctx.fillStyle = c.paper;
      ctx.fillRect(0, 0, w, h);
      const good = this.points.filter(p => p.ok);
      if (!good.length) {
        ctx.fillStyle = c.muted;
        ctx.font = '12px system-ui, sans-serif';
        ctx.fillText('Keine RR-Daten', this.padL, h / 2);
        return;
      }
      let lo = Math.min(...good.map(p => p.hr)), hi = Math.max(...good.map(p => p.hr));
      lo = Math.floor((lo - 3) / 5) * 5; hi = Math.ceil((hi + 3) / 5) * 5;
      const X = t => this.padL + t / this.duration * plotW;
      const Y = hr => padT + (1 - (hr - lo) / (hi - lo)) * plotH;

      if (this.view) {
        ctx.fillStyle = c.minor;
        ctx.fillRect(X(this.view[0]), padT, Math.max(2, X(this.view[1]) - X(this.view[0])), plotH);
      }

      ctx.fillStyle = c.label;
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(String(hi), 4, padT + 9);
      ctx.fillText(String(lo), 4, padT + plotH);
      ctx.fillText('/min', 4, padT + plotH / 2 + 4);
      ctx.fillText('0 s', this.padL, h - 3);
      const endLabel = `${Math.round(this.duration)} s`;
      ctx.fillText(endLabel, w - 6 - ctx.measureText(endLabel).width, h - 3);

      ctx.strokeStyle = c.tachoLine;
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      good.forEach((p, i) => (i ? ctx.lineTo(X(p.t), Y(p.hr)) : ctx.moveTo(X(p.t), Y(p.hr))));
      ctx.stroke();

      ctx.fillStyle = c.tachoBad;
      for (const p of this.points) {
        if (p.ok) continue;
        const y = Math.min(padT + plotH, Math.max(padT, Y(p.hr)));
        ctx.beginPath(); ctx.arc(X(p.t), y, 3, 0, 2 * Math.PI); ctx.fill();
      }
    }
  }

  /* ---------- Durchschnittsschlag mit Messpunkten ---------- */
  const BEAT_SPEED = 50;   // mm/s – gespreizt, damit die Zeiten gut erkennbar sind

  class MedianBeatChart {
    constructor(canvas) {
      this.canvas = canvas;
      this.colors = readColors();
      this.times = null;
      this.onLegend = null;
      new ResizeObserver(() => this.render()).observe(canvas.parentElement);
      themeListeners.push(() => { this.colors = readColors(); this.render(); });
    }

    setData(times, fs) {
      this.times = times;
      this.fs = fs;
      this.render();
    }

    render() {
      const parent = this.canvas.parentElement;
      const w = parent.clientWidth, h = parent.clientHeight;
      if (!w || !h) return;
      const ctx = setupCanvas(this.canvas, w, h);
      const c = this.colors;
      const t = this.times;
      if (!t) {
        ctx.fillStyle = c.paper;
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = c.muted;
        ctx.font = '12px system-ui, sans-serif';
        ctx.fillText('Nicht genug saubere Schläge', 10, h / 2);
        return;
      }
      const n = t.y.length, fs = this.fs;
      const pxPerMm = w / (n / fs * BEAT_SPEED);
      drawGrid(ctx, w, h, pxPerMm, c, 0);

      // Verstärkung 10 mm/mV, bei großen Ausschlägen auf 5 mm/mV reduzieren
      let lo = Infinity, hi = -Infinity;
      for (const v of t.y) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
      const gain = (hi - lo) / 1000 * 10 * pxPerMm > h - 70 ? 5 : 10;
      const scale = gain * pxPerMm / 1000;
      // Nulllinie so, dass die Kurve mittig im Bereich über den Beschriftungen liegt
      const mid = (h - 26) / 2 + 4 + (hi + lo) / 2 * scale;
      const X = i => i / (n - 1) * w;
      const Y = v => mid - v * scale;

      const m = t.marks;
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'center';

      // Grenzpunkte (Beginn/Ende) als gestrichelte Linien, Beschriftung unten – versetzt, damit nichts überlappt
      const bounds = [[m.pOn, 'P-Beginn'], [m.qrsOn, 'QRS-Beginn'], [m.qrsOff, 'J'], [m.tEnd, 'T-Ende']];
      let lastRight = -Infinity, row = 0;
      for (const [i, label] of bounds) {
        if (i == null) continue;
        const x = X(i);
        ctx.strokeStyle = c.markLine;
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, 4); ctx.lineTo(x, h - 20); ctx.stroke();
        ctx.setLineDash([]);
        const tw = ctx.measureText(label).width;
        row = x - tw / 2 < lastRight + 4 ? 1 - row : 0;
        lastRight = x + tw / 2;
        ctx.fillStyle = c.markLine;
        ctx.fillText(label, x, h - (row ? 3 : 14));
      }

      ctx.strokeStyle = c.trace;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i < n; i++) (i ? ctx.lineTo(X(i), Y(t.y[i])) : ctx.moveTo(X(i), Y(t.y[i])));
      ctx.stroke();

      // Wellengipfel als Punkte mit Buchstaben (über positiven, unter negativen Ausschlägen)
      const peaks = [[m.pPeak, 'P'], [m.qPeak, 'Q'], [m.rPeak, 'R'], [m.sPeak, 'S'], [m.tPeak, 'T']];
      ctx.font = 'bold 12px system-ui, sans-serif';
      for (const [i, label] of peaks) {
        if (i == null) continue;
        const x = X(i), yy = Y(t.y[i]), up = t.y[i] >= 0;
        ctx.fillStyle = c.paper;
        ctx.beginPath(); ctx.arc(x, yy, 5, 0, 2 * Math.PI); ctx.fill();
        ctx.fillStyle = c.markLine;
        ctx.beginPath(); ctx.arc(x, yy, 3.5, 0, 2 * Math.PI); ctx.fill();
        ctx.fillText(label, x, up ? yy - 8 : yy + 17);
      }
      ctx.textAlign = 'start';

      if (this.onLegend) this.onLegend(`${BEAT_SPEED} mm/s · ${gain} mm/mV`);
    }
  }

  global.EcgCharts = { LiveEcgChart, ReviewEcgChart, Tachogram, MedianBeatChart, DEFAULT_PX_PER_MM };
})(window);
