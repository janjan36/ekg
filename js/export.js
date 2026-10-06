/* Export: CSV/TXT-Dateien und PDF-Bericht.
 * Auf dem iPhone/iPad gehen Dateien über das Teilen-Menü (Dateien, Mail, AirDrop …),
 * sonst als normaler Download. */
(function (global) {
  'use strict';

  const pad = n => String(n).padStart(2, '0');

  const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  function fileBase(meta) {
    const d = new Date(meta.startTime);
    return `ekg_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_` +
      `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  }

  function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // Leiste mit „Teilen“-Knopf, falls das Teilen-Menü eine frische Nutzeraktion braucht
  function offerShare(file) {
    let bar = document.getElementById('shareBar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'shareBar';
      bar.className = 'share-bar';
      document.body.appendChild(bar);
    }
    bar.innerHTML = '';
    const label = document.createElement('span');
    label.textContent = `${file.name} ist fertig.`;
    const btn = document.createElement('button');
    btn.className = 'btn primary';
    btn.textContent = 'Teilen / Sichern';
    btn.onclick = async () => {
      try { await navigator.share({ files: [file] }); } catch (_) { /* abgebrochen */ }
      bar.remove();
    };
    const close = document.createElement('button');
    close.className = 'btn ghost';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Schließen');
    close.onclick = () => bar.remove();
    bar.append(label, btn, close);
  }

  async function deliver(filename, blob) {
    if (IS_IOS && navigator.canShare) {
      const file = new File([blob], filename, { type: blob.type });
      if (navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file] });
          return;
        } catch (err) {
          if (err.name === 'AbortError') return;
          if (err.name === 'NotAllowedError') { offerShare(file); return; }
        }
      }
    }
    downloadBlob(filename, blob);
  }

  function deliverText(filename, text, mime) {
    return deliver(filename, new Blob([text], { type: mime }));
  }

  function csvFormat(fmt) {
    const de = fmt === 'de';
    return {
      sep: de ? ';' : ',',
      bom: de ? '﻿' : '',
      num: (v, d) => (de ? v.toFixed(d).replace('.', ',') : v.toFixed(d))
    };
  }

  function ecgCsv(rec, fmt) {
    const { sep, bom, num } = csvFormat(fmt);
    const { ecg, fs } = rec.data;
    const lines = [`Zeit_s${sep}EKG_uV`];
    for (let i = 0; i < ecg.length; i++) lines.push(num(i / fs, 4) + sep + ecg[i]);
    return deliverText(fileBase(rec.meta) + '_ekg.csv', bom + lines.join('\r\n') + '\r\n', 'text/csv;charset=utf-8');
  }

  function rrCsv(rec, fmt) {
    const { sep, bom, num } = csvFormat(fmt);
    const { rr, rrT } = rec.data;
    const valid = global.Hrv.validateRR(Array.from(rr));
    const lines = [['Zeit_s', 'RR_ms', 'HF_min', 'gueltig'].join(sep)];
    for (let i = 0; i < rr.length; i++) {
      lines.push([num(rrT[i], 3), num(rr[i], 1), num(60000 / rr[i], 1), valid[i] ? 1 : 0].join(sep));
    }
    return deliverText(fileBase(rec.meta) + '_rr.csv', bom + lines.join('\r\n') + '\r\n', 'text/csv;charset=utf-8');
  }

  // Eine Zeile pro RR-Intervall in ms – wird von Kubios HRV direkt gelesen.
  function rrTxt(rec) {
    const text = Array.from(rec.data.rr, v => Math.round(v)).join('\r\n') + '\r\n';
    return deliverText(fileBase(rec.meta) + '_rr.txt', text, 'text/plain;charset=utf-8');
  }

  function fmtDuration(s) {
    const t = Math.round(s);
    return `${Math.floor(t / 60)}:${pad(t % 60)} min`;
  }

  /* ---------- EDF+ (European Data Format, z. B. für EDFbrowser) ---------- */
  // Kanal 1: EKG-Rohdaten in µV (1 µV je Digitalwert, Bereich ±32,7 mV), Datensätze à 1 s.
  // Kanal 2: „EDF Annotations“ mit Symptomen, Übertragungslücken und automatisch erkannten Extraschlägen.
  // Keine persönlichen Angaben im Kopf (Patientenfeld „X X X X“ nach EDF+-Norm).
  const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const field = (v, n) => String(v).replace(/[^\x20-\x7e]/g, '_').slice(0, n).padEnd(n, ' ');

  function edf(rec) {
    const { meta, data } = rec;
    const fs = data.fs, n = data.ecg.length;
    const nRec = Math.ceil(n / fs);
    const enc = new TextEncoder();

    // Annotationen als TAL (Time-stamped Annotation List): +Beginn[\x15Dauer]\x14Text\x14\x00
    const ann = [];
    for (const t of meta.symptoms || []) ann.push({ t, text: 'Symptom' });
    for (const g of data.gaps || []) ann.push({ t: g.start / fs, d: g.len / fs, text: 'Übertragungslücke' });
    for (const b of rec.analysis ? rec.analysis.beats : []) {
      if (b.type === 'S' || b.type === 'V') ann.push({ t: b.i / fs, text: b.type === 'S' ? 'SVES (automatisch)' : 'VES (automatisch)' });
    }
    ann.sort((a, b) => a.t - b.t);
    const tals = ann.map(a => enc.encode(`+${a.t.toFixed(3)}${a.d ? '\x15' + a.d.toFixed(3) : ''}\x14${a.text}\x14\x00`));
    const total = tals.reduce((s, b) => s + b.length, 0);
    const maxTal = tals.reduce((m, b) => Math.max(m, b.length), 0);
    // Platz je Datensatz: Zeitmarke + Durchschnitt + eine längste TAL Reserve (reicht beim Auffüllen der Reihe nach)
    let annBytes = enc.encode(`+${nRec}\x14\x14\x00`).length + Math.ceil(total / nRec) + maxTal;
    annBytes += annBytes % 2;

    const d = new Date(meta.startTime);
    const ns = 2;
    const both = (a, b, len) => field(a, len) + field(b, len);
    const head =
      field('0', 8) +
      field('X X X X', 80) +
      field(`Startdate ${pad(d.getDate())}-${MONTHS[d.getMonth()]}-${d.getFullYear()} X X Polar_H10`, 80) +
      field(`${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${pad(d.getFullYear() % 100)}`, 8) +
      field(`${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`, 8) +
      field(256 * (ns + 1), 8) +
      field('EDF+C', 44) +
      field(nRec, 8) +
      field(1, 8) +
      field(ns, 4) +
      both('ECG', 'EDF Annotations', 16) +
      both('Polar H10 chest strap', '', 80) +
      both('uV', '', 8) +
      both(-32768, -1, 8) +
      both(32767, 1, 8) +
      both(-32768, -32768, 8) +
      both(32767, 32767, 8) +
      both('None (raw H10 data)', '', 80) +
      both(fs, annBytes / 2, 8) +
      both('', '', 32);

    const recBytes = 2 * fs + annBytes;
    const out = new Uint8Array(head.length + nRec * recBytes);
    for (let i = 0; i < head.length; i++) out[i] = head.charCodeAt(i);
    const dv = new DataView(out.buffer);
    let k = 0;
    for (let r = 0; r < nRec; r++) {
      let o = head.length + r * recBytes;
      for (let j = 0; j < fs; j++, o += 2) {
        const v = data.ecg[Math.min(n - 1, r * fs + j)];   // letzter Datensatz mit dem letzten Wert aufgefüllt
        dv.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(v))), true);
      }
      const end = o + annBytes;
      const keep = enc.encode(`+${r}\x14\x14\x00`);   // Zeitmarke des Datensatzes (Pflicht)
      out.set(keep, o);
      o += keep.length;
      while (k < tals.length && o + tals[k].length <= end) { out.set(tals[k], o); o += tals[k].length; k++; }
    }
    return deliver(fileBase(meta) + '.edf', new Blob([out], { type: 'application/octet-stream' }));
  }

  /* ---------- PDF-Bericht (A4 quer, Millimeter) ---------- */
  const PAGE_W = 297, PAGE_H = 210, MARGIN = 10;
  const STRIP_W = 250;
  const C = {
    minor: '#f2b3b3', major: '#d96b6b', trace: '#000000', bad: '#e3e3e3', text: '#000000',
    muted: '#555555', mark: '#1f6feb',
    tag: { S: '#1f6feb', V: '#c8102e', A: '#b45309', M: '#8250df' },
    level: { ok: '#1a7f37', info: '#b45309', warn: '#c8102e' }
  };

  // Millimeterraster als Linien (Vektor, bleibt scharf)
  function drawGrid(page, x0, y0, w, h) {
    const minor = [], major = [];
    for (let x = 0; x <= w + 1e-6; x++) (x % 5 ? minor : major).push([x0 + x, y0, x0 + x, y0 + h]);
    for (let y = 0; y <= h + 1e-6; y++) (y % 5 ? minor : major).push([x0, y0 + y, x0 + w, y0 + y]);
    page.stroke(C.minor, 0.1); page.lines(minor);
    page.stroke(C.major, 0.25); page.lines(major);
  }

  function drawTag(page, x, y, type) {
    page.fill(C.tag[type]);
    page.rect(x - 1.8, y, 3.6, 3.6);
    page.text(x, y + 2.75, type === 'M' ? '!' : type, { size: 8, bold: true, color: '#ffffff', align: 'center' });
  }

  // Jede Zeile beginnt mit einer Eichzacke 1 mV (200 ms breit) im 8-mm-Vorspann
  const CAL_W = 8;

  function drawStrip(page, x0, y0, rowH, values, fs, start, end, view, ann) {
    const X = i => x0 + CAL_W + (i - start) / fs * view.speed;
    for (const s of ann.bad) {
      if (s.end <= start || s.start >= end) continue;
      const a = X(Math.max(s.start, start)), b = X(Math.min(s.end, end));
      page.fill(C.bad); page.rect(a, y0, b - a, rowH);
    }
    drawGrid(page, x0, y0, STRIP_W + CAL_W, rowH);
    const mid = y0 + rowH / 2;
    const top = mid - view.gain;
    page.stroke(C.trace, 0.4);
    page.polyline([[x0 + 1, mid], [x0 + 2, mid], [x0 + 2, top], [x0 + 7, top], [x0 + 7, mid], [x0 + 8, mid]]);
    const pts = [];
    for (let i = start; i < end; i++) {
      pts.push([X(i), Math.max(y0, Math.min(y0 + rowH, mid - values[i] / 1000 * view.gain))]);
    }
    page.stroke(C.trace, 0.4); page.polyline(pts);
    for (const b of ann.beats) if (b.i >= start && b.i < end) drawTag(page, X(b.i), y0 + 0.4, b.type);
  }

  // Durchschnittsschlag mit Messlinien, 50 mm/s; gibt die belegte Höhe zurück
  function drawBeat(page, x0, y0, times, fs, count) {
    const speed = 50, height = 40;
    const n = times.y.length;
    const width = Math.ceil(n / fs * speed);
    let lo = Infinity, hi = -Infinity;
    for (const v of times.y) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    const gain = (hi - lo) / 1000 * 10 > height - 8 ? 5 : 10;
    const mid = y0 + height / 2 + 3 + (hi + lo) / 2 / 1000 * gain;
    const X = i => x0 + i / fs * speed;
    drawGrid(page, x0, y0, width, height);
    const m = times.marks;
    // Grenzpunkte als Linien (Beschriftung oben, bei Platzmangel versetzt)
    let lastRight = -Infinity, row = 0;
    for (const [i, label] of [[m.pOn, 'P-Beginn'], [m.qrsOn, 'QRS-Beginn'], [m.qrsOff, 'J'], [m.tEnd, 'T-Ende']]) {
      if (i == null) continue;
      const x = X(i), tw = global.Pdf.textWidth(label, 6.5, false);
      row = x - tw / 2 < lastRight + 1 ? 1 - row : 0;
      lastRight = x + tw / 2;
      page.stroke(C.mark, 0.25, [1, 0.8]);
      page.line(x, y0 + 6, x, y0 + height);
      page.text(x, y0 + (row ? 5.4 : 2.6), label, { size: 6.5, color: C.mark, align: 'center' });
    }
    page.stroke(C.trace, 0.45);
    page.polyline(Array.from(times.y, (v, i) => [X(i), mid - v / 1000 * gain]));
    // Wellengipfel als Punkte mit Buchstaben
    for (const [i, label] of [[m.pPeak, 'P'], [m.qPeak, 'Q'], [m.rPeak, 'R'], [m.sPeak, 'S'], [m.tPeak, 'T']]) {
      if (i == null) continue;
      const x = X(i), yy = mid - times.y[i] / 1000 * gain, up = times.y[i] >= 0;
      page.fill(C.mark); page.circle(x, yy, 0.7);
      page.text(x, up ? yy - 1.6 : yy + 3.6, label, { size: 7, bold: true, color: C.mark, align: 'center' });
    }
    const a = times.amps, mv = v => (v == null ? '–' : (v / 1000).toFixed(2).replace('.', ','));
    // Bildunterschrift innerhalb der Bildbreite umbrechen (bei hoher Frequenz ist das Bild schmal)
    const caption = [`Durchschnittsschlag aus ${count} Schlägen · ${speed} mm/s · ${gain} mm/mV`,
      `Amplituden (mV, nicht kalibriert): P ${mv(a.p)} · R ${mv(a.r)} · S ${mv(a.s)} · T ${mv(a.t)}`]
      .flatMap(s => global.Pdf.wrap(s, width, 7, false));
    caption.forEach((line, k) => page.text(x0, y0 + height + 4 + 3.5 * k, line, { size: 7, color: C.muted }));
    return { width, height: height + 1 + 3.5 * caption.length };
  }

  const f0 = v => (v == null ? '–' : v.toFixed(0));
  const ms = v => (v == null ? '–' : `${Math.round(v)} ms`);

  // Befundblock: Überschrift mit Punkt, Befunde mit Punkten; gibt neues y zurück
  function drawFindings(page, x, y, width, headline, level, findings) {
    page.fill(C.level[level || 'info']); page.circle(x + 1.2, y - 1.3, 1.2);
    page.text(x + 4, y, headline, { size: 11, bold: true });
    y += 5.5;
    for (const f of findings) {
      for (const [k, line] of global.Pdf.wrap(f.text, width - 4, 9, false).entries()) {
        if (!k) { page.fill(C.level[f.level]); page.circle(x + 1, y - 1.1, 1); }
        page.text(x + 4, y, line, { size: 9 });
        y += 4.2;
      }
    }
    return y;
  }

  // cur: geöffnete Aufnahme aus app.js ({ meta, data, stats, analysis, hrvx })
  async function pdfReport(cur, view) {
    const { meta, data, stats, analysis: ana, hrvx } = cur;
    const fs = data.fs;
    const values = global.EkgFilters.filtfilt(data.ecg, fs, view);
    const doc = new global.Pdf.PdfDoc(PAGE_W, PAGE_H);
    let page = doc.addPage();
    const right = PAGE_W - MARGIN;
    let y = MARGIN + 5;

    page.text(MARGIN, y, `EKG-Aufzeichnung – ${meta.device}`, { size: 14, bold: true });
    y += 6;
    const filters = [view.highpass && 'Grundlinie 0,5 Hz', view.notch && '50 Hz'].filter(Boolean).join(', ') || 'keine';
    const situation = { liegend: 'Ruhe liegend', sitzend: 'Ruhe sitzend' }[meta.situation];
    page.text(MARGIN, y, `${new Date(meta.startTime).toLocaleString('de-DE')} · Dauer ${fmtDuration(meta.duration)} · ` +
      `${situation ? situation + ' · ' : ''}${view.speed} mm/s · ${view.gain} mm/mV (Eichzacke 1 mV) · ${fs} Hz · Filter: ${filters}` +
      `${meta.note ? ' · Notiz: ' + meta.note : ''}`, { size: 9 });
    y += 5;
    const blocked = !!cur.hrvBlocked;
    const runs = stats ? [
      ['Ø HF ', true], [`${f0(stats.meanHR)} /min    `, false],
      ['Min/Max ', true], [`${f0(stats.minHR)}/${f0(stats.maxHR)} /min    `, false],
      ...(blocked ? [['HRV nicht berechnet (unregelmäßiger Rhythmus)    ', false]] : [
        ['SDNN ', true], [`${f0(stats.sdnn)} ms    `, false],
        ['RMSSD ', true], [`${f0(stats.rmssd)} ms    `, false],
        ['pNN50 ', true], [`${f0(stats.pnn50)} %    `, false]
      ]),
      ['Schläge ', true], [`${stats.beats} (${stats.artifacts} korrigiert)`, false]
    ] : [['Keine RR-Daten', false]];
    page.runs(MARGIN, y, runs, { size: 9 });
    y += 4.5;

    // Erweiterte HRV in einer Zeile
    if (hrvx && !blocked) {
      const { freq, pc, si, dfa } = hrvx;
      const d2 = v => (v == null ? '–' : v.toFixed(2).replace('.', ','));
      const x = [];
      if (freq && freq.lfReliable) x.push(['LF ', true], [`${Math.round(freq.lf)} ms²    `, false], ['HF ', true], [`${Math.round(freq.hf)} ms²    `, false], ['LF/HF ', true], [`${d2(freq.lfhf)}    `, false]);
      else if (freq) x.push(['HF ', true], [`${Math.round(freq.hf)} ms²    `, false]);
      if (pc) x.push(['SD1/SD2 ', true], [`${f0(pc.sd1)}/${f0(pc.sd2)} ms    `, false]);
      if (si != null) x.push(['Stress-Index ', true], [`${si.toFixed(1).replace('.', ',')}    `, false]);
      if (dfa && dfa.a1 != null) x.push(['DFA α1 ', true], [d2(dfa.a1), false]);
      if (x.length) { page.runs(MARGIN, y, x, { size: 9 }); y += 4.5; }
    }
    y += 2.5;

    // Automatische Auswertung: Text links, Durchschnittsschlag rechts
    if (ana) {
      const top = y;
      let beatBox = { width: 0, height: 0 };
      if (ana.times) beatBox = drawBeat(page, right - Math.ceil(ana.times.y.length / fs * 50), top, ana.times, fs, ana.avgCount);
      const textW = right - MARGIN - (beatBox.width ? beatBox.width + 8 : 0);
      y = drawFindings(page, MARGIN, y, textW, `Automatische Auswertung: ${ana.headline}`, ana.level, ana.findings);
      y += 1;
      const t = ana.times;
      page.runs(MARGIN, y, [
        ['PQ ', true], [`${ms(t && t.pq)} · `, false], ['QRS ', true], [`${ms(t && t.qrs)} · `, false],
        ['QT ', true], [`${ms(t && t.qt)} · `, false],
        ['QTc ', true], [`${ms(t && t.qtcF)} (Fridericia), ${ms(t && t.qtcB)} (Bazett)`, false]
      ], { size: 9 });
      y += 4.5;
      const note = 'Markierungen im EKG: ! markiertes Symptom, S supraventrikulärer, V ventrikulärer Extraschlag (wahrscheinlich), ' +
        'A abweichende Form; grau = gestörter Abschnitt. Zeiten sind Näherungswerte (130 Hz, eine Ableitung).';
      for (const line of global.Pdf.wrap(note, textW, 7.5, false)) {
        page.text(MARGIN, y, line, { size: 7.5, color: C.muted });
        y += 3.4;
      }
      y = Math.max(y, top + beatBox.height) + 3;
    }

    // EKG-Streifen, je 250 mm
    const symptoms = (meta.symptoms || []).map(t => ({ i: Math.round(t * fs), type: 'M' }));
    const ann = {
      beats: (ana ? ana.beats.filter(b => 'SVA'.includes(b.type)) : []).concat(symptoms),
      bad: ana ? ana.quality.segments : []
    };
    const rowH = Math.max(20, 3 * view.gain);
    const perRow = Math.round(STRIP_W / view.speed * fs);
    for (let s = 0; s < values.length; s += perRow) {
      const e = Math.min(values.length, s + perRow);
      if (e - s < fs / 2 && s > 0) break;   // winzigen Rest nicht als eigene Zeile
      if (y + 3.5 + rowH > PAGE_H - MARGIN - 4) { page = doc.addPage(); y = MARGIN + 3; }
      page.text(MARGIN, y, `${Math.round(s / fs)}–${Math.round(e / fs)} s`, { size: 7.5, color: C.muted });
      y += 1.5;
      drawStrip(page, MARGIN, y, rowH, values, fs, s, e, view, ann);
      y += rowH + 4.5;
    }

    // Fußzeile auf jeder Seite
    doc.pages.forEach((p, i) => {
      p.text(MARGIN, PAGE_H - MARGIN + 3, 'Einkanal-EKG (Polar H10, 130 Hz). Kein Medizinprodukt – keine Diagnose. ' +
        'Herzinfarkt und Durchblutungsstörungen sind damit nicht erkennbar.', { size: 7, color: C.muted });
      p.text(right, PAGE_H - MARGIN + 3, `Seite ${i + 1} von ${doc.pages.length}`, { size: 7, color: C.muted, align: 'right' });
    });

    const blob = await doc.toBlob();
    await deliver(fileBase(meta) + '.pdf', blob);
    return blob;
  }

  global.EkgExport = { ecgCsv, rrCsv, rrTxt, edf, pdfReport, fmtDuration, IS_IOS };
})(window);
