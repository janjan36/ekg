/* Kennwerte je Aufnahme und Verlaufsansicht über alle Aufnahmen.
 * Die Kennwerte werden beim Speichern berechnet und in den Metadaten abgelegt; ältere Aufnahmen
 * werden beim ersten Öffnen des Verlaufs einmalig nachberechnet. */
(function (global) {
  'use strict';

  const METRICS_VERSION = 1;

  // rec: { meta, data }; ana/resp/posture optional, falls schon berechnet
  function computeMetrics(rec, pre = {}) {
    const { data, meta } = rec;
    const rr = Array.from(data.rr || []);
    const stats = global.Hrv.compute(rr);
    const ana = pre.ana !== undefined ? pre.ana : global.EkgAnalysis.analyze(data.ecg, data.fs);
    const resp = pre.resp !== undefined ? pre.resp : global.Resp.analyze(data.acc, data.accFs);
    const post = pre.posture !== undefined ? pre.posture : global.Posture.analyze(data.acc, data.accFs, pre.upright || null);
    const freq = global.HrvX.frequency(data.rr, data.rrT);
    const dfa = global.HrvX.dfaOf(data.rr);
    return {
      v: METRICS_VERSION,
      hr: stats ? stats.meanHR : null,
      rmssd: stats ? stats.rmssd : null,
      sdnn: stats ? stats.sdnn : null,
      resp: resp ? resp.rate : null,
      qtc: ana && ana.times ? ana.times.qtcB : null,
      lfhf: freq && freq.lfReliable ? freq.lfhf : null,
      si: global.HrvX.stressIndex(data.rr),
      a1: dfa.a1,
      posture: post ? post.main : null,
      motion: post ? post.motion : null
    };
  }

  const isRest = m => !m.test && (!m.metrics || m.metrics.motion == null || m.metrics.motion < 20);

  const SERIES = [
    { key: 'hr', title: 'Herzfrequenz (Ø)', unit: '/min', decimals: 0, rest: true },
    { key: 'rmssd', title: 'RMSSD', unit: 'ms', decimals: 0, rest: true },
    { key: 'resp', title: 'Atemfrequenz', unit: '/min', decimals: 1, rest: true },
    { key: 'qtc', title: 'QTc (Bazett)', unit: 'ms', decimals: 0, rest: true },
    { key: 'lfhf', title: 'LF/HF', unit: '', decimals: 2, rest: true },
    { key: 'si', title: 'Stress-Index', unit: '', decimals: 1, rest: true },
    { test: 'orthostatic', key: 'ratio3015', title: 'Orthostase: 30:15-Verhältnis', unit: '', decimals: 2 },
    { test: 'orthostatic', key: 'dHR3', title: 'Orthostase: HF-Anstieg nach 3 min', unit: '/min', decimals: 0 },
    { test: 'deepBreathing', key: 'dHR', title: 'Tiefe Atmung: HF-Schwankung', unit: '/min', decimals: 0 },
    { test: 'deepBreathing', key: 'ei', title: 'Tiefe Atmung: E/I-Verhältnis', unit: '', decimals: 2 },
    { test: 'biofeedback', key: 'coherence', title: 'Biofeedback: Kohärenz Ø', unit: '%', decimals: 0 }
  ];

  function valueOf(meta, s) {
    if (s.test) return meta.test && meta.test.type === s.test && meta.test.key ? meta.test.key[s.key] : null;
    return meta.metrics ? meta.metrics[s.key] : null;
  }

  class TrendView {
    constructor({ store, onOpen, getUpright }) {
      this.store = store;
      this.onOpen = onOpen;
      this.getUpright = getUpright;
      this.charts = [];
      this.table = false;
      document.getElementById('chkRestOnly').onchange = () => this.render();
      document.getElementById('btnTrendTable').onclick = () => {
        this.table = !this.table;
        document.getElementById('btnTrendTable').textContent = this.table ? 'Als Diagramme' : 'Als Tabelle';
        this.render();
      };
    }

    // Fehlende Kennwerte älterer Aufnahmen einmalig nachberechnen
    async backfill(items) {
      for (const m of items) {
        if (m.metrics && m.metrics.v === METRICS_VERSION) continue;
        const rec = await this.store.get(m.id);
        if (!rec) continue;
        m.metrics = computeMetrics(rec, { upright: this.getUpright() });
        await this.store.updateMeta(m);
      }
    }

    async render() {
      const all = (await this.store.list()).slice().sort((a, b) => a.startTime - b.startTime);
      await this.backfill(all);
      const restOnly = document.getElementById('chkRestOnly').checked;
      const wrap = document.getElementById('trendCharts');
      const tableEl = document.getElementById('trendTable');
      wrap.innerHTML = '';
      this.charts = [];

      const series = SERIES.map(s => {
        const src = s.test ? all : all.filter(m => !restOnly || isRest(m));
        return { s, points: src.map(m => ({ date: m.startTime, value: valueOf(m, s), id: m.id })).filter(p => p.value != null) };
      }).filter(x => x.points.length);

      document.getElementById('trendEmpty').hidden = series.length > 0;
      wrap.hidden = this.table;
      tableEl.hidden = !this.table;
      if (this.table) return this.renderTable(all, restOnly);

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

    renderTable(all, restOnly) {
      const el = document.getElementById('trendTable');
      const rows = all.filter(m => m.test || !restOnly || isRest(m)).reverse();
      const f = (v, d) => (v == null ? '–' : v.toFixed(d).replace('.', ','));
      const mm = m => m.metrics || {};
      el.innerHTML = `<table><thead><tr><th>Datum</th><th>Art</th><th>HF</th><th>RMSSD</th><th>Atmung</th>
        <th>QTc</th><th>LF/HF</th><th>Lage</th><th>Testwert</th></tr></thead><tbody></tbody></table>`;
      const tb = el.querySelector('tbody');
      for (const m of rows) {
        const tr = document.createElement('tr');
        const t = m.test;
        const key = t && t.key ? Object.entries(t.key).filter(([, v]) => v != null)
          .map(([k, v]) => `${k === 'ratio3015' ? '30:15' : k === 'dHR3' ? 'ΔHF 3 min' : k === 'dHR' ? 'ΔHF' : k === 'ei' ? 'E/I' : k === 'coherence' ? 'Kohärenz' : k === 'resonanceRate' ? 'Resonanz' : k} ${f(v, k === 'ratio3015' || k === 'ei' ? 2 : 0)}`).join(', ') : '';
        const cells = [
          new Date(m.startTime).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }),
          t ? global.Tests.NAMES[t.type] : 'Aufnahme',
          f(mm(m).hr, 0), f(mm(m).rmssd, 0), f(mm(m).resp, 1), f(mm(m).qtc, 0), f(mm(m).lfhf, 2),
          mm(m).posture || '–', key || '–'
        ];
        for (const c of cells) { const td = document.createElement('td'); td.textContent = c; tr.appendChild(td); }
        tr.onclick = () => this.onOpen(m.id);
        tb.appendChild(tr);
      }
    }
  }

  global.Trends = { computeMetrics, TrendView, METRICS_VERSION };
})(window);
