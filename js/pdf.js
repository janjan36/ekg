/* Kleiner PDF-Erzeuger ohne Bibliotheken: Linien, Flächen, Kreise und Text (Helvetica).
 * Koordinaten in Millimetern, Ursprung oben links. Ergebnis ist reine Vektorgrafik –
 * scharf in jeder Vergrößerung und maßstabsgetreu beim Drucken. */
(function (global) {
  'use strict';

  const PT = 72 / 25.4;   // Punkt pro Millimeter

  // Zeichenbreiten der Standardschriften (1/1000 em) für ASCII 32–126
  const W_REG = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015,
    667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667,
    611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278,
    556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500,
    500, 334, 260, 334, 584];
  const W_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975,
    722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667,
    611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333,
    611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556,
    500, 389, 280, 389, 584];
  const W_EXTRA = { 'ä': 556, 'ö': 556, 'ü': 556, 'Ä': 667, 'Ö': 778, 'Ü': 722, 'ß': 611, '–': 556,
    '·': 278, 'Ø': 778, 'µ': 556, '°': 400, '•': 350, '…': 1000 };

  // WinAnsi-Kodierung: Latin-1 direkt, dazu einige Sonderzeichen aus dem Bereich 0x80–0x9F
  const WIN_ANSI = { '€': 0x80, '…': 0x85, '•': 0x95, '–': 0x96, '—': 0x97, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94 };

  function charCode(ch) {
    if (WIN_ANSI[ch]) return WIN_ANSI[ch];
    const c = ch.charCodeAt(0);
    return c < 256 ? c : 63;   // '?'
  }

  function textWidth(str, size, bold) {
    let w = 0;
    for (const ch of str) {
      const c = ch.charCodeAt(0);
      w += c >= 32 && c <= 126 ? (bold ? W_BOLD : W_REG)[c - 32] : (W_EXTRA[ch] || 556);
    }
    return w / 1000 * size / PT;   // in mm
  }

  function pdfString(str) {
    let out = '(';
    for (const ch of str) {
      const c = charCode(ch);
      if (c === 40 || c === 41 || c === 92) out += '\\' + ch;
      else if (c < 32 || c > 126) out += '\\' + c.toString(8).padStart(3, '0');
      else out += ch;
    }
    return out + ')';
  }

  const num = v => {
    const s = v.toFixed(2);
    return s.indexOf('.') >= 0 ? s.replace(/\.?0+$/, '') : s;
  };

  function rgb(hex) {
    const h = hex.replace('#', '');
    return [0, 2, 4].map(i => num(parseInt(h.substr(i, 2), 16) / 255)).join(' ');
  }

  class Page {
    constructor(doc) {
      this.doc = doc;
      this.ops = [];
    }

    X(x) { return num(x * PT); }
    Y(y) { return num((this.doc.h - y) * PT); }

    stroke(color, widthMm, dash) {
      this.ops.push(`${rgb(color)} RG ${num(widthMm * PT)} w ${dash ? `[${dash.map(d => num(d * PT)).join(' ')}] 0 d` : '[] 0 d'}`);
      return this;
    }

    fill(color) {
      this.ops.push(`${rgb(color)} rg`);
      return this;
    }

    line(x1, y1, x2, y2) {
      this.ops.push(`${this.X(x1)} ${this.Y(y1)} m ${this.X(x2)} ${this.Y(y2)} l S`);
    }

    // Viele Linien in einem Pfad: segs = [[x1,y1,x2,y2], …]
    lines(segs) {
      if (!segs.length) return;
      this.ops.push(segs.map(([a, b, c, d]) => `${this.X(a)} ${this.Y(b)} m ${this.X(c)} ${this.Y(d)} l`).join(' ') + ' S');
    }

    polyline(points) {
      if (points.length < 2) return;
      this.ops.push('1 J 1 j ' + points.map(([x, y], i) => `${this.X(x)} ${this.Y(y)} ${i ? 'l' : 'm'}`).join(' ') + ' S 0 J 0 j');
    }

    rect(x, y, w, h, mode = 'f') {
      this.ops.push(`${this.X(x)} ${this.Y(y + h)} ${num(w * PT)} ${num(h * PT)} re ${mode}`);
    }

    circle(cx, cy, r) {
      const k = 0.5523 * r;
      const P = (x, y) => `${this.X(x)} ${this.Y(y)}`;
      this.ops.push(`${P(cx + r, cy)} m ` +
        `${P(cx + r, cy + k)} ${P(cx + k, cy + r)} ${P(cx, cy + r)} c ` +
        `${P(cx - k, cy + r)} ${P(cx - r, cy + k)} ${P(cx - r, cy)} c ` +
        `${P(cx - r, cy - k)} ${P(cx - k, cy - r)} ${P(cx, cy - r)} c ` +
        `${P(cx + k, cy - r)} ${P(cx + r, cy - k)} ${P(cx + r, cy)} c f`);
    }

    // y = Grundlinie der Schrift; align: left | center | right. Gibt die Textbreite in mm zurück.
    text(x, y, str, { size = 9, bold = false, color = '#000000', align = 'left' } = {}) {
      const w = textWidth(str, size, bold);
      const x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
      this.ops.push(`BT /${bold ? 'F2' : 'F1'} ${num(size)} Tf ${rgb(color)} rg ${this.X(x0)} ${this.Y(y)} Td ${pdfString(str)} Tj ET`);
      return w;
    }

    // Text in Stücken mit wechselnder Schrift: runs = [[text, bold], …]
    runs(x, y, runs, opts = {}) {
      let cx = x;
      for (const [t, bold] of runs) cx += this.text(cx, y, t, { ...opts, bold });
      return cx - x;
    }
  }

  // Zeilenumbruch nach Wörtern auf maxW mm
  function wrap(str, maxW, size, bold) {
    const lines = [];
    let cur = '';
    for (const word of str.split(' ')) {
      const next = cur ? cur + ' ' + word : word;
      if (cur && textWidth(next, size, bold) > maxW) { lines.push(cur); cur = word; } else cur = next;
    }
    if (cur) lines.push(cur);
    return lines;
  }

  class PdfDoc {
    constructor(widthMm = 297, heightMm = 210) {
      this.w = widthMm;
      this.h = heightMm;
      this.pages = [];
    }

    addPage() {
      const p = new Page(this);
      this.pages.push(p);
      return p;
    }

    async toBlob() {
      const enc = s => {
        const b = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
        return b;
      };
      const deflate = async bytes => {
        if (!global.CompressionStream) return null;
        try {
          const cs = new CompressionStream('deflate');
          const buf = await new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer();
          return new Uint8Array(buf);
        } catch (_) { return null; }
      };

      const chunks = [];
      let length = 0;
      const offsets = [];
      const push = part => {
        const b = typeof part === 'string' ? enc(part) : part;
        chunks.push(b);
        length += b.length;
      };
      const obj = (id, body) => {
        offsets[id] = length;
        push(`${id} 0 obj\n`);
        for (const part of [].concat(body)) push(part);
        push('\nendobj\n');
      };

      const n = this.pages.length;
      const pageId = i => 5 + i * 2;
      push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
      obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
      obj(2, `<< /Type /Pages /Count ${n} /Kids [${this.pages.map((_, i) => `${pageId(i)} 0 R`).join(' ')}] >>`);
      obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
      obj(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
      for (let i = 0; i < n; i++) {
        obj(pageId(i), `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(this.w * PT)} ${num(this.h * PT)}] ` +
          `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageId(i) + 1} 0 R >>`);
        const raw = enc(this.pages[i].ops.join('\n'));
        const packed = await deflate(raw);
        const data = packed || raw;
        obj(pageId(i) + 1, [
          `<< /Length ${data.length}${packed ? ' /Filter /FlateDecode' : ''} >>\nstream\n`, data, '\nendstream'
        ]);
      }
      const count = 5 + n * 2;
      const xref = length;
      let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
      for (let id = 1; id < count; id++) table += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
      push(table + `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
      return new Blob(chunks, { type: 'application/pdf' });
    }
  }

  global.Pdf = { PdfDoc, textWidth, wrap };
})(window);
