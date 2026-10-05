/* Kennwerte je Aufnahme und Verlaufsansicht über alle Aufnahmen.
 * Die Kennwerte werden beim Speichern berechnet und in den Metadaten abgelegt; ältere Aufnahmen
 * werden beim ersten Öffnen des Verlaufs einmalig nachberechnet. */
(function (global) {
  'use strict';

  // 3: ohne Atmung/Lage, QTc nach Fridericia
  // 4: Artefaktkorrektur nach Lipponen & Tarvainen; keine HRV bei Vorhofflimmer-Muster; HRV erst ab 2 min
  const METRICS_VERSION = 4;
  const HRV_MIN_S = 120;

  // rec: { meta, data }; pre.ana optional, falls schon berechnet
  function computeMetrics(rec, pre = {}) {
    const { data, meta } = rec;
    const stats = global.Hrv.compute(Array.from(data.rr || []));
    const ana = pre.ana !== undefined ? pre.ana
      : global.EkgAnalysis.analyze(data.ecg, data.fs, { ref: { rr: data.rr, rrT: data.rrT }, gaps: data.gaps, situation: meta.situation });
    const af = !!(ana && ana.rhythm.af);
    // HRV nur bei regelmäßigem Grundrhythmus und vergleichbarer Dauer
    const hrv = !af && meta.duration >= HRV_MIN_S;
    const freq = hrv ? global.HrvX.frequency(data.rr, data.rrT) : null;
    return {
      v: METRICS_VERSION,
      hr: stats ? stats.meanHR : null,
      rmssd: stats && hrv ? stats.rmssd : null,
      sdnn: stats && hrv ? stats.sdnn : null,
      // QTc nur bei Frequenz ≤ 100/min und regelmäßigem Rhythmus (sonst ist die Korrektur unzuverlässig)
      qtc: ana && ana.times && !af && ana.rhythm.hr <= 100 ? ana.times.qtcF : null,
      lfhf: freq && freq.lfReliable ? freq.lfhf : null,
      si: hrv ? global.HrvX.stressIndex(data.rr) : null
    };
  }

  // Im Verlauf nur echte Gurt-Aufnahmen: keine Demo-Daten und keine Aufnahmen aus den früheren
  // geführten Tests (andere Bedingungen, z. B. Aufstehen oder gelenkte Atmung)
  const include = m => !/^Demo/.test(m.device || '') && !m.test;
  const SITUATION_NAMES = { liegend: 'Ruhe liegend', sitzend: 'Ruhe sitzend', belastung: 'Belastung' };

  const SERIES = [
    { key: 'hr', title: 'Herzfrequenz (Ø)', unit: '/min', decimals: 0 },
    { key: 'rmssd', title: 'RMSSD', unit: 'ms', decimals: 0 },
    { key: 'qtc', title: 'QTc (Fridericia)', unit: 'ms', decimals: 0 },
    { key: 'lfhf', title: 'LF/HF', unit: '', decimals: 2 },
    { key: 'si', title: 'Stress-Index', unit: '', decimals: 1 }
  ];

  class TrendView {
    constructor({ store, onOpen }) {
      this.store = store;
      this.onOpen = onOpen;
      this.charts = [];
      this.table = false;
      this.situation = '';   // '' = alle
      document.getElementById('selTrendSituation').onchange = e => { this.situation = e.target.value; this.render(); };
      document.getElementById('btnTrendTable').onclick = () => {
        this.table = !this.table;
        document.getElementById('btnTrendTable').textContent = this.table ? 'Als Diagramme' : 'Als Tabelle';
        this.render();
      };
    }

    // Fehlende oder veraltete Kennwerte einmalig nachberechnen
    async backfill(items) {
      for (const m of items) {
        if (m.metrics && m.metrics.v === METRICS_VERSION) continue;
        const rec = await this.store.get(m.id);
        if (!rec) continue;
        m.metrics = computeMetrics(rec);
        await this.store.updateMeta(m);
      }
    }

    async render() {
      const all = (await this.store.list())
        .filter(m => include(m) && (!this.situation || m.situation === this.situation))
        .sort((a, b) => a.startTime - b.startTime);
      await this.backfill(all);
      const wrap = document.getElementById('trendCharts');
      const tableEl = document.getElementById('trendTable');
      wrap.innerHTML = '';
      this.charts = [];

      const series = SERIES.map(s => ({
        s,
        points: all.map(m => ({ date: m.startTime, value: m.metrics ? m.metrics[s.key] : null, id: m.id }))
          .filter(p => p.value != null)
      })).filter(x => x.points.length);

      document.getElementById('trendEmpty').hidden = series.length > 0;
      wrap.hidden = this.table;
      tableEl.hidden = !this.table;
      if (this.table) return this.renderTable(all);

      for (const { s, points } of series) {
        const card = document.createElement('div');
        card.className = 'trend-card';
        const last = points[points.length - 1].value;
        card.innerHTML = `<div class="trend-title"><span></span><b></b></div><div class="trend-box"><canvas></canvas></div>`;
        card.querySelector('span').textContent = s.title;
        card.querySelector('b').textContent = `zuletzt ${last.toFixed(s.decimals).replace('.', ',')} ${s.unit}`.trim();
        wrap.appendChild(card);
        const chart = new global.Charts2.TrendChart(card.querySelector('canvas'), {
          unit: s.unit, decimals: s.decimals, onOpen: this.onOpen
        });
        chart.setData(points);
        this.charts.push(chart);
      }
    }

    renderTable(all) {
      const el = document.getElementById('trendTable');
      const f = (v, d) => (v == null ? '–' : v.toFixed(d).replace('.', ','));
      el.innerHTML = `<table><thead><tr><th>Datum</th><th>Dauer</th><th>Situation</th><th>HF</th><th>RMSSD</th><th>SDNN</th>
        <th>QTc</th><th>LF/HF</th><th>Stress-Index</th></tr></thead><tbody></tbody></table>`;
      const tb = el.querySelector('tbody');
      for (const m of all.slice().reverse()) {
        const mm = m.metrics || {};
        const tr = document.createElement('tr');
        const cells = [
          new Date(m.startTime).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }),
          global.EkgExport.fmtDuration(m.duration),
          SITUATION_NAMES[m.situation] || '–',
          f(mm.hr, 0), f(mm.rmssd, 0), f(mm.sdnn, 0), f(mm.qtc, 0), f(mm.lfhf, 2), f(mm.si, 1)
        ];
        for (const c of cells) { const td = document.createElement('td'); td.textContent = c; tr.appendChild(td); }
        tr.onclick = () => this.onOpen(m.id);
        tb.appendChild(tr);
      }
    }
  }

  global.Trends = { computeMetrics, TrendView, METRICS_VERSION, include };
})(window);
