/* Steuerung der Oberfläche: Reiter, Verbindung, Live-Anzeige, Aufnahme,
 * Aufnahmeliste, Detailansicht und Verlauf. */
(function () {
  'use strict';

  const FS = 130;
  const MIN_SAVE_SECONDS = 5;
  const MAX_GAP_S = 30;     // längste Lücke, die in einer Aufnahme aufgefüllt wird
  const $ = id => document.getElementById(id);
  const de = (v, d = 0) => (v == null || !isFinite(v) ? '–' : v.toFixed(d).replace('.', ','));

  /* ---------- Einstellungen (pro Browser gemerkt) ---------- */
  const SETTINGS_KEY = 'polar-ekg-settings';
  const settings = Object.assign({
    speed: 25, gain: 10, highpass: true, notch: true,
    pxPerMm: EcgCharts.DEFAULT_PX_PER_MM, csv: 'de', duration: 300, situation: 'sitzend'
  }, (() => {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (_) { return {}; }
  })());
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) { /* egal */ }
  }
  const viewOpts = () => ({ speed: settings.speed, gain: settings.gain, highpass: settings.highpass, notch: settings.notch });

  // Ruhe-EKG: die Körperlage bestimmt, welche Aufnahmen im Verlauf vergleichbar sind
  const SITUATIONS = { liegend: 'Ruhe liegend', sitzend: 'Ruhe sitzend' };
  const isRest = s => s === 'liegend' || s === 'sitzend';

  // Auswertung einer gespeicherten Aufnahme
  const analyzeRec = (data, meta) => EkgAnalysis.analyze(data.ecg, data.fs, {
    ref: { rr: data.rr, rrT: data.rrT }, gaps: data.gaps, symptoms: meta.symptoms
  });

  /* ---------- Zustand ---------- */
  let store = null;
  let source = null;
  let connected = false;
  let liveFilter = new EkgFilters.FilterChain(FS, settings);
  let liveBeats = [];       // { t: Wanduhr in s, rr } der letzten 3 min
  const LIVE_ANALYSIS_S = 30;
  let liveRaw = [];         // Rohdaten der letzten 30 s für die Live-Auswertung
  let liveAbs = 0;          // empfangene Werte seit live.clear() – gleiche Zählung wie im Live-Chart
  let liveMarkers = [];     // erkannte Extraschläge [{ abs, type }]
  let liveCounts = { S: 0, V: 0 };
  let liveAf = false;       // Vorhofflimmer-Muster in den letzten 2 min → keine HRV-Werte live
  let lastEcgWall = 0;      // Empfangszeit des letzten EKG-Pakets (ms)
  let analysisTimer = 0;
  let rec = null;           // laufende Aufnahme
  let current = null;       // geöffnete Aufnahme
  let wakeLock = null;
  let timerHandle = 0;
  let activeTab = 'messen';

  const live = new EcgCharts.LiveEcgChart($('liveCanvas'), FS);
  const review = new EcgCharts.ReviewEcgChart($('reviewScroll'), $('reviewInner'), $('reviewCanvas'), FS);
  const tacho = new EcgCharts.Tachogram($('tachoCanvas'), t => review.scrollToTime(t));
  review.onView = (t0, t1) => tacho.setView(t0, t1);
  const beatChart = new EcgCharts.MedianBeatChart($('beatCanvas'));
  beatChart.onLegend = text => {
    if (current && current.analysis) {
      $('beatLegend').textContent = `Durchschnittsschlag aus ${current.analysis.avgCount} Schlägen · ${text}`;
    }
  };
  const psdChart = new Charts2.PsdChart($('psdCanvas'));
  const poincareChart = new Charts2.PoincareChart($('poincareCanvas'));

  /* ---------- Reiter ---------- */
  function showTab(name) {
    activeTab = name;
    document.querySelectorAll('.tabs [data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    document.querySelectorAll('[data-panel]').forEach(el => {
      // Die Detailansicht nur zeigen, wenn eine Aufnahme geöffnet ist
      el.hidden = el.dataset.panel !== name || (el.id === 'review' && !current);
    });
    if (name === 'verlauf' && trendView) trendView.render();
  }

  /* ---------- Status-Anzeige ---------- */
  function setStatus(text, state) {
    const pill = $('statusPill');
    pill.textContent = text;
    pill.dataset.state = state || (connected ? 'connected' : 'idle');
  }

  function updateButtons() {
    $('btnConnect').hidden = connected;
    $('btnDemo').hidden = connected;
    $('btnDisconnect').hidden = !connected;
    $('btnConnect').disabled = !PolarH10Source.isSupported();
    $('btnRecord').disabled = !connected;
    $('btnRecord').classList.toggle('active', !!rec);
    $('btnRecordLabel').textContent = rec ? 'Aufnahme beenden' : 'Aufnahme starten';
    $('selDuration').disabled = !!rec;
    $('selSituation').disabled = !!rec;
    $('btnSymptom').hidden = !rec;
    $('btnSymptomLabel').textContent = rec && rec.symptoms.length
      ? `Symptom markieren (${rec.symptoms.length})` : 'Symptom markieren';
  }

  function resetLiveValues() {
    ['valHr', 'valRr', 'valRmssd'].forEach(id => { $(id).textContent = '–'; });
    $('valSignal').textContent = 'ms';
    liveBeats = [];
    liveAf = false;
    lastEcgWall = 0;
    $('battery').hidden = true;
    $('contact').hidden = true;
    resetLiveAnalysis();
  }

  /* ---------- Live-Auswertung ---------- */
  // Live-Kurve und Zählung neu beginnen (z. B. nach Filterwechsel); keepCounts behält die Extraschlag-Zahlen
  function resetLiveAnalysis(keepCounts) {
    liveRaw = [];
    liveAbs = 0;
    liveMarkers = [];
    live.clear();
    if (keepCounts) return;
    liveCounts = { S: 0, V: 0 };
    ['liveRhythm', 'liveEctopic', 'liveQuality', 'liveTimes'].forEach(id => {
      $(id).textContent = '–';
      $(id).dataset.level = '';
    });
  }

  const LIVE_RHYTHM = { regular: 'regelmäßig', variable: 'regelmäßig, schwankend', na: 'noch nicht beurteilbar' };

  function runLiveAnalysis() {
    if (liveRaw.length < 10 * FS) {
      $('liveRhythm').textContent = 'startet nach 10 s …';
      return;
    }
    const res = EkgAnalysis.analyze(Float32Array.from(liveRaw), FS);
    if (!res) return;

    // Neue Extraschläge übernehmen; die Ränder des Fensters sind noch unsicher
    const absStart = liveAbs - liveRaw.length;
    const lo = FS, hi = liveRaw.length - Math.round(1.5 * FS);
    for (const b of res.beats) {
      if ((b.type !== 'S' && b.type !== 'V') || b.i < lo || b.i > hi) continue;
      const abs = absStart + b.i;
      if (liveMarkers.some(m => Math.abs(m.abs - abs) < 0.2 * FS)) continue;
      liveMarkers.push({ abs, type: b.type });
      liveCounts[b.type]++;
    }
    if (liveMarkers.length > 200) liveMarkers.splice(0, liveMarkers.length - 200);
    live.setMarkers(liveMarkers);

    // Vorhofflimmer-Muster nur aus den letzten 2 min RR-Daten des Gurts (≥ 100 Schläge) beurteilen –
    // das 30-s-Fenster ist dafür zu kurz
    const now = Date.now() / 1000;
    const rr2 = liveBeats.filter(b => now - b.t <= 120).map(b => b.rr);
    const irr = rr2.length >= EkgAnalysis.AF_MIN_BEATS ? EkgAnalysis.irregularity(rr2) : null;
    liveAf = !!(irr && irr.af);
    const rh = $('liveRhythm');
    rh.textContent = liveAf ? 'unregelmäßig (VHF-Muster?)' : LIVE_RHYTHM[res.rhythm.label.code];
    rh.dataset.level = liveAf ? 'warn' : '';
    const ect = liveCounts.S + liveCounts.V;
    $('liveEctopic').textContent = ect ? `${liveCounts.S} × S · ${liveCounts.V} × V` : 'keine';
    $('liveEctopic').dataset.level = ect ? 'info' : '';
    const pct = Math.round(res.quality.good * 100);
    $('liveQuality').textContent = pct >= 90 ? `gut (${pct} %)` : `gestört (${pct} % auswertbar)`;
    $('liveQuality').dataset.level = pct >= 90 ? '' : pct >= 60 ? 'info' : 'warn';
    const t = res.times;
    $('liveTimes').textContent = t && (t.qrs || t.qtcF)
      ? `${t.qrs ? Math.round(t.qrs) + ' ms' : '–'} · ${t.qtcF ? Math.round(t.qtcF) + ' ms' : '–'}`
      : '–';
  }

  // Symptom-Taste: markiert die aktuelle Stelle der Aufnahme (ESC 2024: symptombezogener ≥ 30-s-Streifen
  // ist ärztlich verwertbar)
  function markSymptom() {
    if (!rec) return;
    const t = rec.ecg.length / FS;
    if (rec.symptoms.some(s => Math.abs(s - t) < 2)) return;   // Doppeltipp
    rec.symptoms.push(t);
    liveMarkers.push({ abs: liveAbs, type: 'M' });
    live.setMarkers(liveMarkers);
    updateButtons();
  }

  /* ---------- Handler für Gurt bzw. Demo ---------- */
  const handlers = {
    onEcg(samples, info) {
      const nowMs = Date.now();
      // Verlorene Werte laut Zeitstempel des Gurts – höchstens so viele, wie seit dem letzten Paket
      // Zeit vergangen ist (sonst eher ein Zeitstempel-Sprung)
      const wallGap = lastEcgWall ? Math.round(((nowMs - lastEcgWall) / 1000 + 1) * FS) : 0;
      let lost = Math.min(info.lost || 0, wallGap);
      lastEcgWall = nowMs;
      // Nach einer Wiederverbindung: Länge der Unterbrechung aus der Uhrzeit schätzen
      if (rec && rec.awaitGap) {
        rec.awaitGap = false;
        const missing = wallGap - FS - samples.length;
        if (missing > FS / 4) {
          lost = Math.max(lost, missing);
          rec.rrElapsed += missing / FS;   // RR-Zeitachse mitführen (während der Lücke keine RR-Werte)
        }
      }
      lost = Math.min(lost, MAX_GAP_S * FS);
      const out = new Float32Array(samples.length);
      for (let i = 0; i < samples.length; i++) out[i] = liveFilter.process(samples[i]);
      live.push(out);
      // Live-Auswertung nicht über eine Lücke hinweg
      if (lost) liveRaw = [];
      for (let i = 0; i < samples.length; i++) liveRaw.push(samples[i]);
      liveAbs += samples.length;
      if (liveRaw.length > LIVE_ANALYSIS_S * FS) liveRaw.splice(0, liveRaw.length - LIVE_ANALYSIS_S * FS);
      if (lost) $('valSignal').textContent = `ms · ${lost} Werte verloren`;
      if (rec) {
        if (lost) {
          // Lücke auffüllen (letzter Wert) und merken, statt die Kurve zusammenzuschieben –
          // so stimmt die Zeitachse, und die Auswertung lässt die Stelle aus
          rec.lost += lost;
          const n = Math.min(lost, rec.maxSamples - rec.ecg.length);
          const fill = rec.ecg.length ? rec.ecg[rec.ecg.length - 1] : 0;
          if (n > 0) rec.gaps.push({ start: rec.ecg.length, len: n });
          for (let i = 0; i < n; i++) rec.ecg.push(fill);
        }
        const room = rec.maxSamples - rec.ecg.length;
        for (let i = 0; i < Math.min(room, samples.length); i++) rec.ecg.push(samples[i]);
        if (rec.ecg.length >= rec.maxSamples) stopRecording();
      }
    },

    onHr({ hr, rr, contact }) {
      $('valHr').textContent = hr || '–';
      if (contact !== null) {
        $('contact').hidden = false;
        $('contact').textContent = contact ? 'Hautkontakt ✓' : 'kein Hautkontakt';
      }
      // Schlagzeiten rückwärts vom Eintreffen der Meldung verteilen
      const now = Date.now() / 1000;
      let t = now - rr.reduce((s, v) => s + v / 1000, 0);
      for (const v of rr) {
        t += v / 1000;
        liveBeats.push({ t, rr: v });
        if (rec) {
          rec.rrElapsed += v / 1000;
          rec.rr.push(v);
          rec.rrT.push(rec.rrElapsed);
        }
      }
      if (rr.length) $('valRr').textContent = Math.round(rr[rr.length - 1]);
      liveBeats = liveBeats.filter(b => now - b.t <= 180);
      const s = liveAf ? null : Hrv.compute(liveBeats.filter(b => now - b.t <= 60).map(b => b.rr));
      $('valRmssd').textContent = s && s.rmssd != null ? Math.round(s.rmssd) : '–';
    },

    onBattery(level) {
      $('battery').hidden = false;
      $('battery').textContent = `Akku ${level} %`;
    },

    onStatus(text) {
      setStatus(text, connected ? 'connected' : 'busy');
    },

    async onDisconnect({ manual }) {
      const wasConnected = connected;
      connected = false;
      if (!manual && wasConnected && source && await source.reconnect()) {
        connected = true;
        if (rec) { rec.interrupted = true; rec.awaitGap = true; }
        setStatus(rec ? 'Aufnahme läuft' : `Verbunden: ${source.name}`, rec ? 'recording' : 'connected');
        updateButtons();
        return;
      }
      if (rec) await stopRecording({ reason: manual ? '' : 'Verbindung unterbrochen' });
      clearInterval(analysisTimer);
      source = null;
      live.clear();
      resetLiveValues();
      setStatus(manual ? 'Nicht verbunden' : 'Verbindung verloren', manual ? 'idle' : 'error');
      updateButtons();
    }
  };

  async function connect(SourceClass) {
    source = new SourceClass(handlers);
    liveFilter = new EkgFilters.FilterChain(FS, settings);
    live.clear();
    resetLiveValues();
    $('connectNotice').hidden = true;
    const t0 = Date.now();
    try {
      setStatus('Verbinde …', 'busy');
      // getAvailability gibt es nicht in jedem Browser (z. B. Bluefy) – dann einfach versuchen
      if (SourceClass === PolarH10Source && navigator.bluetooth.getAvailability &&
          !(await navigator.bluetooth.getAvailability())) {
        throw new Error('Bluetooth ist ausgeschaltet oder kein Adapter gefunden.');
      }
      await source.connect();
      connected = true;
      setStatus(`Verbunden: ${source.name}`, 'connected');
      clearInterval(analysisTimer);
      analysisTimer = setInterval(runLiveAnalysis, 2000);
    } catch (err) {
      console.error(err);
      source = null;
      connected = false;
      if (err && err.name === 'NotFoundError' && Date.now() - t0 < 1500) {
        // Abbruch ohne sichtbaren Dialog: Browser hat keinen Bluetooth-Auswahldialog
        $('connectNotice').hidden = false;
        setStatus('Kein Auswahldialog', 'error');
      } else if (err && err.name === 'NotFoundError') {
        setStatus('Nicht verbunden', 'idle');   // Nutzer hat den Dialog abgebrochen
      } else {
        setStatus(`Fehler: ${err.message || err}`, 'error');
      }
    }
    updateButtons();
  }

  /* ---------- Aufnahme ---------- */
  function startRecording() {
    if (!connected || rec) return;
    rec = {
      startTime: Date.now(),
      device: source.name,
      situation: settings.situation,
      maxSamples: settings.duration * FS,
      ecg: [], rr: [], rrT: [], rrElapsed: 0, lost: 0, gaps: [], symptoms: []
    };
    if (navigator.wakeLock) navigator.wakeLock.request('screen').then(w => { wakeLock = w; }).catch(() => {});
    timerHandle = setInterval(updateTimer, 250);
    updateTimer();
    setStatus('Aufnahme läuft', 'recording');
    updateButtons();
  }

  const recTime = () => (rec ? rec.ecg.length / FS : 0);

  function updateTimer() {
    const s = recTime();
    const left = rec ? Math.max(0, rec.maxSamples / FS - s) : 0;
    $('timer').textContent = rec ? `${fmtClock(s)} / −${fmtClock(left)}` : '00:00';
  }

  function fmtClock(s) {
    const t = Math.floor(s);
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  }

  // opts: { reason }
  async function stopRecording(opts = {}) {
    if (!rec) return;
    const r = rec;
    rec = null;
    clearInterval(timerHandle);
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    $('timer').textContent = fmtClock(r.ecg.length / FS);
    if (connected) setStatus(`Verbunden: ${r.device}`, 'connected');
    updateButtons();

    const duration = r.ecg.length / FS;
    if (duration < MIN_SAVE_SECONDS) {
      setStatus('Aufnahme zu kurz – nicht gespeichert', connected ? 'connected' : 'idle');
      return;
    }
    setStatus('Speichern und auswerten …', 'busy');
    const stats = Hrv.compute(r.rr);
    const ecg = Int32Array.from(r.ecg);
    const data = { fs: FS, ecg, rr: Float32Array.from(r.rr), rrT: Float32Array.from(r.rrT), gaps: r.gaps };
    const meta = {
      startTime: r.startTime,
      duration,
      device: r.device,
      situation: r.situation,
      symptoms: r.symptoms
    };
    const ana = analyzeRec(data, meta);
    const af = !!(ana && ana.rhythm.af);
    Object.assign(meta, {
      meanHR: stats ? stats.meanHR : null,
      rmssd: stats && !af ? stats.rmssd : null,
      analysis: ana ? { level: ana.level, ectopic: ana.counts.S + ana.counts.V } : null,
      lost: r.lost,
      note: opts.reason || (r.interrupted ? 'Verbindung kurz unterbrochen' : '')
    });
    meta.metrics = Trends.computeMetrics({ meta, data }, { ana });
    const id = await store.save(meta, data);
    if (connected) setStatus(`Verbunden: ${r.device}`, 'connected'); else setStatus('Nicht verbunden', 'idle');
    await renderList();
    await openRecording(id);
  }

  /* ---------- Aufnahmeliste ---------- */
  async function renderList() {
    const items = await store.list();
    const ul = $('recList');
    ul.innerHTML = '';
    $('recEmpty').hidden = items.length > 0;
    for (const m of items) {
      const li = document.createElement('li');
      const hr = m.meanHR ? `Ø ${Math.round(m.meanHR)} /min` : 'keine HF';
      const rmssd = m.rmssd != null ? ` · RMSSD ${Math.round(m.rmssd)} ms` : '';
      const es = m.analysis && m.analysis.ectopic ? ` · ${m.analysis.ectopic} Extraschl.` : '';
      const sy = m.symptoms && m.symptoms.length ? ` · ${m.symptoms.length} Symptom${m.symptoms.length > 1 ? 'e' : ''}` : '';
      li.innerHTML = `
        <div class="rec-main">
          <div class="rec-date"><span class="level-dot inline"></span></div>
          <div class="rec-meta"></div>
        </div>
        <div class="rec-actions">
          <button class="btn small" data-act="open">Ansehen</button>
          <button class="btn small ghost" data-act="del">Löschen</button>
        </div>`;
      const dot = li.querySelector('.level-dot');
      if (m.analysis) dot.dataset.level = m.analysis.level; else dot.remove();
      li.querySelector('.rec-date').append(new Date(m.startTime).toLocaleString('de-DE'));
      const sit = SITUATIONS[m.situation] ? ` · ${SITUATIONS[m.situation]}` : '';
      li.querySelector('.rec-meta').textContent =
        `${EkgExport.fmtDuration(m.duration)}${sit} · ${hr}${rmssd}${es}${sy}${m.note ? ' · ' + m.note : ''}`;
      li.querySelector('[data-act="open"]').onclick = () => openRecording(m.id);
      li.querySelector('[data-act="del"]').onclick = async () => {
        if (!confirm('Diese Aufnahme wirklich löschen?')) return;
        await store.remove(m.id);
        if (current && current.meta.id === m.id) closeReview();
        renderList();
      };
      ul.appendChild(li);
    }
  }

  /* ---------- Detailansicht ---------- */
  async function openRecording(id) {
    const r = await store.get(id);
    if (!r) return;
    const { data, meta } = r;
    const analysis = analyzeRec(data, meta);
    current = {
      ...r,
      stats: Hrv.compute(Array.from(data.rr)),
      analysis,
      // Bei Vorhofflimmer-Muster ist HRV nicht aussagekräftig
      hrvBlocked: !!(analysis && analysis.rhythm.af),
      hrvx: {
        freq: HrvX.frequency(data.rr, data.rrT),
        pc: HrvX.poincare(data.rr),
        si: HrvX.stressIndex(data.rr),
        dfa: HrvX.dfaOf(data.rr)
      },
      norm: await personalNorm(meta)
    };
    // Ältere Aufnahmen: Ampel und Extraschlag-Zahl in der Liste an die aktuelle Auswertung angleichen
    if (analysis) {
      const summary = { level: analysis.level, ectopic: analysis.counts.S + analysis.counts.V };
      if (!meta.analysis || meta.analysis.level !== summary.level || meta.analysis.ectopic !== summary.ectopic) {
        meta.analysis = summary;
        await store.updateMeta(meta);
        renderList();
      }
    }
    $('reviewTitle').textContent = `Aufnahme vom ${new Date(meta.startTime).toLocaleString('de-DE')}`;
    $('reviewNote').value = meta.note || '';
    $('reviewSituation').value = meta.situation || '';
    showTab('aufnahmen');
    renderStats();
    renderAnalysis();
    renderHrvx();
    showReviewData();
    $('review').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Persönlicher Normalbereich (Mittelwert ± 1 SD) aus mindestens 5 anderen Ruhe-Aufnahmen
  // derselben Lage – wie im Verlauf
  async function personalNorm(meta) {
    if (!isRest(meta.situation) || !trendView) return null;
    const others = (await store.list()).filter(m => m.id !== meta.id && m.situation === meta.situation && Trends.include(m));
    await trendView.backfill(others);
    const ok = others.filter(m => m.metrics && m.metrics.hr != null && m.metrics.rmssd != null);
    if (ok.length < 5) return null;
    const band = vals => {
      const m = vals.reduce((a, b) => a + b, 0) / vals.length;
      return { m, sd: Math.sqrt(vals.reduce((a, v) => a + (v - m) ** 2, 0) / (vals.length - 1)) };
    };
    return { n: ok.length, hr: band(ok.map(m => m.metrics.hr)), rmssd: band(ok.map(m => m.metrics.rmssd)) };
  }

  function showReviewData() {
    if (!current) return;
    const { data, meta, stats } = current;
    review.setScale({ speed: settings.speed, gain: settings.gain, pxPerMm: settings.pxPerMm });
    review.setData(EkgFilters.filtfilt(data.ecg, data.fs, settings));
    tacho.setData(Array.from(data.rrT), Array.from(data.rr), stats ? stats.valid : [], meta.duration);
    review.setAnnotations(annotationsOf(current));
  }

  // Markierungen für EKG-Ansicht und PDF: Extraschläge, Symptome (M), gestörte Abschnitte
  function annotationsOf(cur) {
    const a = cur.analysis;
    const fs = cur.data.fs;
    const symptoms = (cur.meta.symptoms || []).map(t => ({ i: Math.round(t * fs), type: 'M' }));
    return {
      beats: (a ? a.beats.filter(b => 'SVA'.includes(b.type)) : []).concat(symptoms),
      bad: a ? a.quality.segments : []
    };
  }

  function fillDl(dl, rows) {
    dl.innerHTML = '';
    for (const [k, v] of rows) {
      const div = document.createElement('div');
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      div.append(dt, dd);
      dl.appendChild(div);
    }
  }

  function fillFindings(ul, findings) {
    ul.innerHTML = '';
    for (const f of findings) {
      const li = document.createElement('li');
      li.dataset.level = f.level;
      li.textContent = f.text;
      ul.appendChild(li);
    }
  }

  const QUALITY_NAMES = { flat: 'kein Signal', motion: 'Bewegung', noise: 'Störung', gap: 'Übertragungslücke' };

  function renderAnalysis() {
    const a = current.analysis;
    const box = $('analysisBox');
    $('anaDot').dataset.level = a ? a.level : 'info';
    $('anaHeadline').textContent = a ? `Automatische Auswertung: ${a.headline}` : 'Automatische Auswertung: Aufnahme zu kurz';
    box.querySelector('.analysis-grid').hidden = !a;
    fillFindings($('anaFindings'), a ? a.findings : []);
    if (!a) return;

    const t = a.times;
    const ms = v => (v == null ? '–' : `${Math.round(v)} ms`);
    const mv = v => (v == null ? '–' : (v / 1000).toFixed(2).replace('.', ','));
    fillDl($('anaTimes'), [
      ['PQ (120–200)', ms(t && t.pq)],
      ['QRS (< 120)', ms(t && t.qrs)],
      ['QT', ms(t && t.qt)],
      ['QTc Fridericia (♂ < 450 / ♀ < 460)', ms(t && t.qtcF)],
      ['QTc Bazett (Vergleich)', ms(t && t.qtcB)],
      ['RR (Median)', ms(a.rhythm.medianRR)],
      ['R / S-Amplitude', t ? `${mv(t.amps.r)} / ${mv(t.amps.s)} mV` : '–'],
      ['P / T-Amplitude', t ? `${mv(t.amps.p)} / ${mv(t.amps.t)} mV` : '–']
    ]);
    $('beatLegend').textContent = t ? `Durchschnittsschlag aus ${a.avgCount} Schlägen` : 'Durchschnittsschlag';
    beatChart.setData(t, a.fs);

    // Ereignisliste: Symptome, Extraschläge und gestörte Abschnitte
    const events = [
      ...(current.meta.symptoms || []).map(t => ({ t, tag: 'M', text: 'Symptom' })),
      ...a.beats.filter(b => 'SVA'.includes(b.type)).map(b => ({ t: b.i / a.fs, tag: b.type, text: EkgAnalysis.TYPE_NAMES[b.type] })),
      ...a.quality.segments.map(s => ({ t: s.start / a.fs, tag: 'U', text: QUALITY_NAMES[s.type] }))
    ].sort((x, y) => x.t - y.t);
    const wrap = $('anaEvents');
    wrap.innerHTML = '';
    if (!events.length) wrap.textContent = 'keine';
    const MAX = 60;
    for (const e of events.slice(0, MAX)) {
      const b = document.createElement('button');
      b.innerHTML = `<span class="tag ${e.tag}">${e.tag === 'U' || e.tag === 'M' ? '!' : e.tag}</span>`;
      b.append(`${e.t.toFixed(1).replace('.', ',')} s ${e.text}`);
      b.onclick = () => review.scrollToTime(e.t);
      wrap.appendChild(b);
    }
    if (events.length > MAX) wrap.append(` … und ${events.length - MAX} weitere`);
  }

  function renderHrvx() {
    const { meta, stats, hrvBlocked, norm } = current;
    if (hrvBlocked) {
      fillDl($('hrvxRows'), ['LF', 'HF', 'LF/HF', 'SD1 / SD2', 'Stress-Index (√SI)', 'DFA α1'].map(k => [k, '–']));
      psdChart.setData(null, 'Nicht berechnet (unregelmäßiger Rhythmus)');
      poincareChart.setData(null, 'Nicht berechnet (unregelmäßiger Rhythmus)');
      fillFindings($('hrvxNotes'), [{
        level: 'info',
        text: 'HRV-Werte nicht berechnet: Bei unregelmäßigem Rhythmus (Muster wie bei Vorhofflimmern) sind sie nicht aussagekräftig.'
      }]);
      return;
    }
    const { freq, pc, si, dfa } = current.hrvx;
    fillDl($('hrvxRows'), [
      ['LF', freq && freq.lfReliable ? `${Math.round(freq.lf)} ms²` : '–'],
      ['HF', freq ? `${Math.round(freq.hf)} ms²` : '–'],
      ['LF/HF', freq && freq.lfReliable ? de(freq.lfhf, 2) : '–'],
      ['LF n.u. / HF n.u.', freq && freq.lfReliable ? `${de(freq.lfnu)} / ${de(freq.hfnu)}` : '–'],
      ['HF-Gipfel', freq && freq.hfPeak ? `${de(freq.hfPeak, 2)} Hz` : '–'],
      ['SD1 / SD2', pc ? `${de(pc.sd1)} / ${de(pc.sd2)} ms` : '–'],
      ['Stress-Index (√SI)', de(si, 1)],
      ['DFA α1', dfa.a1 != null ? de(dfa.a1, 2) : '–']
    ]);
    psdChart.setData(freq);
    poincareChart.setData(pc);

    const notes = [];
    // Vergleich mit dem persönlichen Normalbereich (nur Ruhe, ab 2 min wie im Verlauf)
    if (norm && stats && meta.duration >= 120) {
      const hrHigh = stats.meanHR > norm.hr.m + norm.hr.sd;
      const rmssdLow = stats.rmssd < norm.rmssd.m - norm.rmssd.sd;
      if (hrHigh && rmssdLow) {
        notes.push({ level: 'info', text: `Ruhe-Herzfrequenz höher (${de(stats.meanHR)} statt Ø ${de(norm.hr.m)} /min) und RMSSD niedriger ` +
          `(${de(stats.rmssd)} statt Ø ${de(norm.rmssd.m)} ms) als dein Normalbereich aus ${norm.n} Aufnahmen „${SITUATIONS[meta.situation]}“ – ` +
          'passt oft zu beginnendem Infekt, Übertraining, Schlafmangel oder Stress.' });
      }
    }
    if (!freq) notes.push({ level: 'info', text: 'Frequenzanalyse ab 1 Minute sauberer Daten; LF und LF/HF erst ab 2 Minuten (Task Force 1996). Für Vergleiche untereinander 5 Minuten empfohlen.' });
    else if (!freq.lfReliable) notes.push({ level: 'info', text: 'Aufnahme unter 2 Minuten – LF und LF/HF sind noch nicht aussagekräftig.' });
    if (freq && freq.lfReliable) {
      notes.push({ level: 'info', text: 'LF/HF hängt stark von der Atmung ab: Bei langsamer Atmung (unter ca. 9 Atemzügen/min) liegt die Atemschwankung im LF-Band. Als „Stressbalance“ ist LF/HF wissenschaftlich umstritten.' });
    }
    if (dfa.tooMany) {
      notes.push({ level: 'info', text: `DFA α1 nicht angegeben: ${de(dfa.share * 100)} % der RR-Intervalle mussten korrigiert werden – ` +
        'über 5 % verfälscht die Korrektur den Wert (Rogers et al. 2021).' });
    } else if (dfa.a1 != null) {
      notes.push({ level: 'ok', text: `DFA α1 ${de(dfa.a1, 2)} – Kurzzeit-Korrelation der Herzschlag-Abstände (4–16 Schläge); ` +
        'in Ruhe bei Gesunden meist um 1. Am aussagekräftigsten im Vergleich eigener Aufnahmen.' });
    }
    if (si != null) notes.push({ level: si > 15 ? 'info' : 'ok', text: `Stress-Index ${de(si, 1)} – in Ruhe typisch etwa 7–12; höhere Werte sprechen für mehr Sympathikus-Aktivität (Anspannung, Belastung, Müdigkeit).` });
    fillFindings($('hrvxNotes'), notes);
  }

  function renderStats() {
    const { meta, stats, hrvBlocked } = current;
    const f = (v, d = 0) => (v == null ? '–' : v.toFixed(d).replace('.', ','));
    const hrv = stats && !hrvBlocked;
    const rows = [
      ['Dauer', EkgExport.fmtDuration(meta.duration)],
      ['Situation', SITUATIONS[meta.situation] || 'keine Angabe'],
      ['Ø Herzfrequenz', stats ? `${f(stats.meanHR)} /min` : '–'],
      ['Min / Max', stats ? `${f(stats.minHR)} / ${f(stats.maxHR)} /min` : '–'],
      ['SDNN', hrv ? `${f(stats.sdnn)} ms` : '–'],
      ['RMSSD', hrv ? `${f(stats.rmssd)} ms` : '–'],
      ['pNN50', hrv ? `${f(stats.pnn50, 1)} %` : '–'],
      ['Schläge / korrigiert', stats ? `${stats.beats} / ${stats.artifacts} (${f(stats.artifactShare * 100, 1)} %)` : '–'],
      ['Gerät', meta.device]
    ];
    if (meta.lost) rows.push(['Verlorene Werte', String(meta.lost)]);
    fillDl($('reviewStats'), rows);
  }

  function closeReview() {
    current = null;
    $('review').hidden = true;
  }

  /* ---------- Darstellungsoptionen ---------- */
  function applyView() {
    $('liveLegend').textContent = `${settings.speed} mm/s · ${settings.gain} mm/mV`;
    live.setScale({ speed: settings.speed, gain: settings.gain, pxPerMm: settings.pxPerMm });
    if (current) {
      review.setScale({ speed: settings.speed, gain: settings.gain, pxPerMm: settings.pxPerMm });
    }
    $('calibBar').style.width = (50 * settings.pxPerMm) + 'px';
  }

  let trendView = null;

  function bindControls() {
    $('selSpeed').value = settings.speed;
    $('selGain').value = settings.gain;
    $('chkHp').checked = settings.highpass;
    $('chkNotch').checked = settings.notch;
    $('rngScale').value = settings.pxPerMm;
    $('selCsv').value = settings.csv;
    $('selDuration').value = settings.duration;
    if (!SITUATIONS[settings.situation]) settings.situation = 'sitzend';
    $('selSituation').value = settings.situation;

    document.querySelectorAll('.tabs [data-tab]').forEach(b => { b.onclick = () => showTab(b.dataset.tab); });

    $('selSpeed').onchange = e => { settings.speed = +e.target.value; saveSettings(); applyView(); };
    $('selGain').onchange = e => { settings.gain = +e.target.value; saveSettings(); applyView(); };
    $('rngScale').oninput = e => { settings.pxPerMm = +e.target.value; saveSettings(); applyView(); };
    $('selCsv').onchange = e => { settings.csv = e.target.value; saveSettings(); };
    $('selDuration').onchange = e => { settings.duration = +e.target.value; saveSettings(); };
    $('selSituation').onchange = e => { settings.situation = e.target.value; saveSettings(); };
    $('btnSymptom').onclick = markSymptom;
    const onFilter = () => {
      settings.highpass = $('chkHp').checked;
      settings.notch = $('chkNotch').checked;
      saveSettings();
      liveFilter = new EkgFilters.FilterChain(FS, settings);
      resetLiveAnalysis(true);
      if (current) {
        const t = review.currentTime;
        review.setData(EkgFilters.filtfilt(current.data.ecg, current.data.fs, settings));
        review.scrollToTime(t);
      }
    };
    $('chkHp').onchange = onFilter;
    $('chkNotch').onchange = onFilter;

    $('btnConnect').onclick = () => connect(PolarH10Source);
    $('btnDemo').onclick = () => connect(DemoSource);
    $('btnDisconnect').onclick = async () => {
      if (rec) await stopRecording();
      if (source) await source.disconnect();
    };
    $('btnRecord').onclick = () => (rec ? stopRecording() : startRecording());

    $('btnCloseReview').onclick = closeReview;
    $('reviewNote').onchange = async e => {
      if (!current) return;
      current.meta.note = e.target.value.trim();
      await store.updateMeta(current.meta);
      renderList();
    };
    // Lage nachträglich ändern (z. B. für ältere Aufnahmen) – Vergleich mit dem Normalbereich neu aufbauen
    $('reviewSituation').onchange = async e => {
      if (!current) return;
      const t = review.currentTime;
      current.meta.situation = e.target.value || undefined;
      await store.updateMeta(current.meta);
      await renderList();
      await openRecording(current.meta.id);
      review.scrollToTime(t);
    };
    $('btnCsvEcg').onclick = () => current && EkgExport.ecgCsv(current, settings.csv);
    $('btnCsvRr').onclick = () => current && EkgExport.rrCsv(current, settings.csv);
    $('btnTxtRr').onclick = () => current && EkgExport.rrTxt(current);
    $('btnEdf').onclick = () => current && EkgExport.edf(current);
    $('btnPdf').onclick = async () => {
      if (!current) return;
      const btn = $('btnPdf');
      btn.disabled = true;
      btn.textContent = 'PDF wird erstellt …';
      try {
        await EkgExport.pdfReport(current, viewOpts());
      } catch (err) {
        console.error(err);
        alert('PDF konnte nicht erstellt werden: ' + (err.message || err));
      } finally {
        btn.disabled = false;
        btn.textContent = 'PDF';
      }
    };

    window.addEventListener('beforeunload', e => {
      if (rec) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  /* ---------- Start ---------- */
  async function init() {
    $('bleNotice').hidden = PolarH10Source.isSupported();
    $('bleNoticeIos').hidden = !EkgExport.IS_IOS;
    // Browser bitten, die Aufnahmen nicht automatisch zu löschen (v. a. iOS räumt sonst auf)
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    const opened = await EkgStorage.openStorage();
    store = opened.store;
    $('storageNotice').hidden = opened.persistent;
    trendView = new Trends.TrendView({ store, onOpen: openRecording });
    bindControls();
    applyView();
    updateButtons();
    showTab('messen');
    await renderList();
  }

  init();
})();
