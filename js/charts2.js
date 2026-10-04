/* Weitere Diagramme: Frequenzspektrum, Poincaré-Plot und Verlaufskurven. Alle mit Hover-/Tipp-Anzeige der genauen Werte. */
(function (global) {
  'use strict';

  function vars() {
    const s = getComputedStyle(document.documentElement);
    const v = n => s.getPropertyValue(n).trim();
    return {
      surface: v('--card'), text: v('--text'), muted: v('--muted'), grid: v('--border'),
      line: v('--tacho-line'), s1: v('--series-1'), s2: v('--series-2'), band: v('--trend-band'),
      mark: v('--mark-line'), bad: v('--tacho-bad')
    };
  }

  function setup(canvas) {
    const parent = canvas.parentElement;
    const w = parent.clientWidth, h = parent.clientHeight;
    if (!w || !h) return null;
    const dpr = global.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  const de = (v, d = 0) => v.toFixed(d).replace('.', ',');

  // Gemeinsamer Unterbau: Größenänderung, Farbwechsel, Tooltip
  class BaseChart {
    constructor(canvas) {
      this.canvas = canvas;
      this.c = vars();
      this.tip = document.createElement('div');
      this.tip.className = 'chart-tip';
      this.tip.hidden = true;
      canvas.parentElement.appendChild(this.tip);
      canvas.parentElement.style.position = 'relative';
      new ResizeObserver(() => this.render()).observe(canvas.parentElement);
      global.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { this.c = vars(); this.render(); });
      canvas.addEventListener('pointermove', e => this._hover(e));
      canvas.addEventListener('pointerdown', e => this._hover(e));   // Tippen auf dem Handy
      canvas.addEventListener('pointerleave', () => { this.hoverX = null; this.tip.hidden = true; this.render(); });
    }

    _hover(e) {
      const r = this.canvas.getBoundingClientRect();
      this.hoverX = e.clientX - r.left;
      this.hoverY = e.clientY - r.top;
      this.render();
    }

    showTip(x, y, html) {
      this.tip.innerHTML = html;
      this.tip.hidden = false;
      const pw = this.canvas.parentElement.clientWidth;
      const tw = this.tip.offsetWidth;
      this.tip.style.left = Math.max(4, Math.min(pw - tw - 4, x + 12)) + 'px';
      this.tip.style.top = Math.max(4, y - 36) + 'px';
    }

    empty(ctx, w, h, text) {
      ctx.fillStyle = this.c.muted;
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText(text, 10, h / 2);
      this.tip.hidden = true;
    }
  }

  /* ---------- Frequenzspektrum ---------- */
  class PsdChart extends BaseChart {
    setData(freq) { this.freq = freq; this.render(); }

    render() {
      const s = setup(this.canvas);
      if (!s) return;
      const { ctx, w, h } = s, c = this.c;
      ctx.fillStyle = c.surface; ctx.fillRect(0, 0, w, h);
      if (!this.freq) return this.empty(ctx, w, h, 'Mindestens 1 Minute saubere Daten nötig');
      const { f, p } = this.freq.spec;
      const fMax = 0.5, padL = 8, padB = 18, padT = 8, pw = w - padL - 8, ph = h - padB - padT;
      let pMax = 0;
      for (let k = 0; k < f.length && f[k] <= fMax; k++) pMax = Math.max(pMax, p[k]);
      pMax = pMax * 1.1 || 1;
      const X = v => padL + v / fMax * pw, Y = v => padT + ph - v / pMax * ph;

      // Bänder als Flächen unter der Kurve
      const band = (lo, hi, color) => {
        ctx.beginPath();
        ctx.moveTo(X(lo), Y(0));
        for (let k = 0; k < f.length; k++) if (f[k] >= lo && f[k] <= hi) ctx.lineTo(X(f[k]), Y(p[k]));
        ctx.lineTo(X(hi), Y(0));
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.55;
        ctx.fill();
        ctx.globalAlpha = 1;
      };
      band(0.04, 0.15, c.s1);
      band(0.15, 0.4, c.s2);

      ctx.strokeStyle = c.line; ctx.lineWidth = 2; ctx.lineJoin = 'round';
      ctx.beginPath();
      let first = true;
      for (let k = 0; k < f.length && f[k] <= fMax; k++) {
        if (first) { ctx.moveTo(X(f[k]), Y(p[k])); first = false; } else ctx.lineTo(X(f[k]), Y(p[k]));
      }
      ctx.stroke();

      ctx.strokeStyle = c.grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, Y(0) + 0.5); ctx.lineTo(w - 8, Y(0) + 0.5); ctx.stroke();
      ctx.fillStyle = c.muted; ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'center';
      for (const t of [0, 0.1, 0.2, 0.3, 0.4, 0.5]) ctx.fillText(de(t, 1), X(t), h - 4);
      ctx.textAlign = 'right'; ctx.fillText('Hz', w - 8, h - 4); ctx.textAlign = 'start';

      if (this.hoverX != null) {
        const fq = (this.hoverX - padL) / pw * fMax;
        if (fq >= 0 && fq <= fMax) {
          let k = 0;
          while (k < f.length - 1 && f[k] < fq) k++;
          ctx.strokeStyle = c.muted; ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.moveTo(X(f[k]), padT); ctx.lineTo(X(f[k]), Y(0)); ctx.stroke(); ctx.setLineDash([]);
          const bandName = f[k] < 0.04 ? 'VLF' : f[k] < 0.15 ? 'LF' : f[k] < 0.4 ? 'HF' : '';
          this.showTip(X(f[k]), Y(p[k]), `<b>${de(f[k], 3)} Hz</b> ${bandName}<br>${Math.round(p[k])} ms²/Hz<br>≙ ${de(f[k] * 60, 1)} /min`);
        }
      }
    }
  }

  /* ---------- Poincaré-Plot ---------- */
  class PoincareChart extends BaseChart {
    setData(pc) { this.pc = pc; this.render(); }

    render() {
      const s = setup(this.canvas);
      if (!s) return;
      const { ctx, w, h } = s, c = this.c;
      ctx.fillStyle = c.surface; ctx.fillRect(0, 0, w, h);
      if (!this.pc) return this.empty(ctx, w, h, 'Zu wenige Schläge');
      const { pairs, sd1, sd2, meanRR } = this.pc;
      const all = pairs.flat();
      let lo = Math.min(...all), hi = Math.max(...all);
      const padV = Math.max(20, (hi - lo) * 0.1);
      lo -= padV; hi += padV;
      const pad = 30, size = Math.min(w, h) - pad - 8;
      const X = v => pad + (v - lo) / (hi - lo) * size, Y = v => 8 + size - (v - lo) / (hi - lo) * size;

      ctx.strokeStyle = c.grid; ctx.lineWidth = 1;
      ctx.strokeRect(pad + 0.5, 8.5, size, size);
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(X(lo), Y(lo)); ctx.lineTo(X(hi), Y(hi)); ctx.stroke();
      ctx.setLineDash([]);

      // SD1/SD2-Ellipse um den Mittelpunkt, 45° gedreht
      const k = size / (hi - lo);
      ctx.save();
      ctx.translate(X(meanRR), Y(meanRR));
      ctx.rotate(-Math.PI / 4);
      ctx.strokeStyle = c.s2; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(0, 0, sd2 * 2 * k, sd1 * 2 * k, 0, 0, 2 * Math.PI); ctx.stroke();
      ctx.restore();

      ctx.fillStyle = c.s1;
      ctx.globalAlpha = 0.6;
      for (const [a, b] of pairs) { ctx.beginPath(); ctx.arc(X(a), Y(b), 2.5, 0, 2 * Math.PI); ctx.fill(); }
      ctx.globalAlpha = 1;

      ctx.fillStyle = c.muted; ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(String(Math.round(lo)), pad, 8 + size + 13);
      ctx.textAlign = 'right'; ctx.fillText(String(Math.round(hi)), pad + size, 8 + size + 13);
      ctx.fillText(String(Math.round(hi)), pad - 3, 18);
      ctx.fillText(String(Math.round(lo)), pad - 3, 8 + size);
      ctx.textAlign = 'start';

      if (this.hoverX != null) {
        let best = null, bd = 400;
        for (const pr of pairs) {
          const d = (X(pr[0]) - this.hoverX) ** 2 + (Y(pr[1]) - this.hoverY) ** 2;
          if (d < bd) { bd = d; best = pr; }
        }
        if (best) {
          ctx.strokeStyle = c.text; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(X(best[0]), Y(best[1]), 5, 0, 2 * Math.PI); ctx.stroke();
          this.showTip(X(best[0]), Y(best[1]), `RR<sub>n</sub> ${Math.round(best[0])} ms<br>RR<sub>n+1</sub> ${Math.round(best[1])} ms`);
        } else this.tip.hidden = true;
      }
    }
  }

  /* ---------- Verlauf über Aufnahmen ---------- */
  class TrendChart extends BaseChart {
    // points: [{ date (ms), value, id }], opts: { title, unit, decimals, onOpen }
    constructor(canvas, opts) {
      super(canvas);
      this.opts = opts;
      canvas.addEventListener('click', () => { if (this.hot && opts.onOpen) opts.onOpen(this.hot.id); });
      canvas.style.cursor = 'pointer';
    }

    setData(points) { this.points = points; this.render(); }

    render() {
      const s = setup(this.canvas);
      if (!s) return;
      const { ctx, w, h } = s, c = this.c, o = this.opts;
      ctx.fillStyle = c.surface; ctx.fillRect(0, 0, w, h);
      const pts = (this.points || []).filter(p => p.value != null && isFinite(p.value));
      if (!pts.length) return this.empty(ctx, w, h, 'Keine Werte');
      const vals = pts.map(p => p.value);
      const m = vals.reduce((a, b) => a + b, 0) / vals.length;
      const sd = vals.length > 1 ? Math.sqrt(vals.reduce((a, v) => a + (v - m) ** 2, 0) / (vals.length - 1)) : 0;
      const showBand = vals.length >= 5;
      let lo = Math.min(...vals, showBand ? m - sd : Infinity), hi = Math.max(...vals, showBand ? m + sd : -Infinity);
      const padV = (hi - lo) * 0.12 || Math.abs(hi) * 0.1 || 1;
      lo -= padV; hi += padV;
      const d0 = pts[0].date, d1 = pts[pts.length - 1].date;
      const padL = 44, padR = 10, padT = 8, padB = 18, pw = w - padL - padR, ph = h - padT - padB;
      const X = d => (d1 === d0 ? padL + pw / 2 : padL + (d - d0) / (d1 - d0) * pw);
      const Y = v => padT + ph - (v - lo) / (hi - lo) * ph;
      const fmt = v => de(v, o.decimals || 0);

      if (showBand) {
        ctx.fillStyle = c.band;
        ctx.fillRect(padL, Y(m + sd), pw, Y(m - sd) - Y(m + sd));
      }
      ctx.strokeStyle = c.grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, padT + ph + 0.5); ctx.lineTo(padL + pw, padT + ph + 0.5); ctx.stroke();

      ctx.fillStyle = c.muted; ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'right';
      ctx.fillText(fmt(hi), padL - 5, padT + 9);
      ctx.fillText(fmt(lo), padL - 5, padT + ph);
      ctx.textAlign = 'start';
      const dateStr = d => new Date(d).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
      ctx.fillText(dateStr(d0), padL, h - 3);
      if (d1 !== d0) { ctx.textAlign = 'right'; ctx.fillText(dateStr(d1), padL + pw, h - 3); ctx.textAlign = 'start'; }

      if (pts.length > 1) {
        ctx.strokeStyle = c.s1; ctx.lineWidth = 2; ctx.lineJoin = 'round';
        ctx.beginPath();
        pts.forEach((p, i) => (i ? ctx.lineTo(X(p.date), Y(p.value)) : ctx.moveTo(X(p.date), Y(p.value))));
        ctx.stroke();
      }
      for (const p of pts) {
        ctx.fillStyle = c.surface; ctx.beginPath(); ctx.arc(X(p.date), Y(p.value), 5, 0, 2 * Math.PI); ctx.fill();
        ctx.fillStyle = c.s1; ctx.beginPath(); ctx.arc(X(p.date), Y(p.value), 4, 0, 2 * Math.PI); ctx.fill();
      }

      this.hot = null;
      if (this.hoverX != null) {
        let best = null, bd = Infinity;
        for (const p of pts) { const d = Math.abs(X(p.date) - this.hoverX); if (d < bd) { bd = d; best = p; } }
        if (best && bd < 40) {
          this.hot = best;
          ctx.strokeStyle = c.text; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(X(best.date), Y(best.value), 6, 0, 2 * Math.PI); ctx.stroke();
          const when = new Date(best.date).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
          this.showTip(X(best.date), Y(best.value), `<b>${fmt(best.value)} ${o.unit}</b><br>${when}${showBand ? `<br>Normalbereich ${fmt(m - sd)}–${fmt(m + sd)}` : ''}`);
        } else this.tip.hidden = true;
      }
    }
  }

  global.Charts2 = { PsdChart, PoincareChart, TrendChart };
})(window);
