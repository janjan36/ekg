/* Steuerung der Oberfläche: Verbindung, Live-Anzeige, Aufnahme, Aufnahmeliste und Detailansicht. */
(function () {
  'use strict';

  const FS = 130;
  const MIN_SAVE_SECONDS = 5;
  const $ = id => document.getElementById(id);

  /* ---------- Einstellungen (pro Browser gemerkt) ---------- */
  const SETTINGS_KEY = 'polar-ekg-settings';
  const settings = Object.assign({
    speed: 25, gain: 10, highpass: true, notch: true,
    pxPerMm: EcgCharts.DEFAULT_PX_PER_MM, csv: 'de', duration: 300
  }, (() => {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (_) { return {}; }
  })());
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) { /* egal */ }
  }
  const viewOpts = () => ({ speed: settings.speed, gain: settings.gain, highpass: settings.highpass, notch: settings.notch });

  /* ---------- Zustand ---------- */
  let store = null;
  let source = null;
  let connected = false;
  let liveFilter = new EkgFilters.FilterChain(FS, settings);
  let liveRR = [];          // { t: ms-Zeitstempel, rr }
  let liveResp = null;      // Resp.LiveRespiration
  let respShownAt = 0;
  const LIVE_ANALYSIS_S = 30;
  let liveRaw = [];         // Rohdaten der letzten 30 s für die Live-Auswertung
  let liveAbs = 0;          // empfangene Werte seit live.clear() – gleiche Zählung wie im Live-Chart
  let liveMarkers = [];     // erkannte Extraschläge [{ abs, type }]
  let liveCounts = { S: 0, V: 0 };
  let analysisTimer = 0;
  let rec = null;           // laufende Aufnahme
  let current = null;       // geöffnete Aufnahme { meta, data, stats }
  let wakeLock = null;
  let timerHandle = 0;

  const live = new EcgCharts.LiveEcgChart($('liveCanvas'), FS);
  const review = new EcgCharts.ReviewEcgChart($('reviewScroll'), $('reviewInner'), $('reviewCanvas'), FS);
  const tacho = new EcgCharts.Tachogram($('tachoCanvas'), t => review.scrollToTime(t));
  const respLive = new EcgCharts.RespChart($('respLiveCanvas'));
  const respReview = new EcgCharts.RespChart($('respReviewCanvas'), t => review.scrollToTime(t));
  review.onView = (t0, t1) => { tacho.setView(t0, t1); respReview.setView(t0, t1); };
  respLive.setData({}, 30, 'Warte auf Atemdaten …');
  const beatChart = new EcgCharts.MedianBeatChart($('beatCanvas'));
  beatChart.onLegend = text => {
    if (current && current.analysis) {
      $('beatLegend').textContent = `Durchschnittsschlag aus ${current.analysis.avgCount} Schlägen · ${text}`;
    }
  };

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
  }

  function resetLiveValues() {
    ['valHr', 'valRr', 'valRmssd', 'valContact', 'valResp'].forEach(id => { $(id).textContent = '–'; });
    $('valSignal').textContent = '';
    $('valRespUnit').textContent = '/min';
    liveResp = null;
    respLive.setData({}, 30, 'Warte auf Atemdaten …');
    $('battery').hidden = true;
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

    const rh = $('liveRhythm');
    rh.textContent = res.rhythm.af ? 'unregelmäßig (VHF-Muster?)' : LIVE_RHYTHM[res.rhythm.label.code];
    rh.dataset.level = res.rhythm.af ? 'warn' : '';
    const ect = liveCounts.S + liveCounts.V;
    $('liveEctopic').textContent = ect ? `${liveCounts.S} × S · ${liveCounts.V} × V` : 'keine';
    $('liveEctopic').dataset.level = ect ? 'info' : '';
    const pct = Math.round(res.quality.good * 100);
    $('liveQuality').textContent = pct >= 90 ? `gut (${pct} %)` : `gestört (${pct} % auswertbar)`;
    $('liveQuality').dataset.level = pct >= 90 ? '' : pct >= 60 ? 'info' : 'warn';
    const t = res.times;
    $('liveTimes').textContent = t && (t.qrs || t.qtcB)
      ? `${t.qrs ? Math.round(t.qrs) + ' ms' : '–'} · ${t.qtcB ? Math.round(t.qtcB) + ' ms' : '–'}`
      : '–';
  }

  /* ---------- Handler für Gurt bzw. Demo ---------- */
  const handlers = {
    onEcg(samples, info) {
      const out = new Float32Array(samples.length);
      for (let i = 0; i < samples.length; i++) out[i] = liveFilter.process(samples[i]);
      live.push(out);
      for (let i = 0; i < samples.length; i++) liveRaw.push(samples[i]);
      liveAbs += samples.length;
      if (liveRaw.length > LIVE_ANALYSIS_S * FS) liveRaw.splice(0, liveRaw.length - LIVE_ANALYSIS_S * FS);
      if (info.lost) $('valSignal').textContent = `${info.lost} Werte verloren`;
      if (rec) {
        rec.lost += info.lost || 0;
        const room = rec.maxSamples - rec.ecg.length;
        for (let i = 0; i < Math.min(room, samples.length); i++) rec.ecg.push(samples[i]);
        if (rec.ecg.length >= rec.maxSamples) stopRecording();
      }
    },

    onAcc(xyz, info) {
      if (!liveResp || liveResp.accFs !== info.fs) liveResp = new Resp.LiveRespiration(info.fs);
      liveResp.push(xyz);
      if (rec) {
        rec.accFs = info.fs;
        for (let i = 0; i < xyz.length; i++) rec.acc.push(xyz[i]);
      }
      const now = Date.now();
      if (now - respShownAt < 500) return;
      respShownAt = now;
      const r = liveResp.result();
      respLive.setData(r, 30, 'Atemkurve erscheint nach einigen Sekunden …');
      $('valResp').textContent = r.rate ? Math.round(r.rate) : '–';
    },

    onHr({ hr, rr, contact }) {
      $('valHr').textContent = hr || '–';
      if (contact !== null) $('valContact').textContent = contact ? 'ja' : 'nein';
      const now = Date.now();
      for (const v of rr) {
        liveRR.push({ t: now, rr: v });
        if (rec) {
          rec.rrElapsed += v / 1000;
          rec.rr.push(v);
          rec.rrT.push(rec.rrElapsed);
        }
      }
      if (rr.length) $('valRr').textContent = Math.round(rr[rr.length - 1]);
      liveRR = liveRR.filter(p => now - p.t <= 60000);
      const s = Hrv.compute(liveRR.map(p => p.rr));
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
        if (rec) rec.interrupted = true;
        setStatus(rec ? 'Aufnahme läuft' : `Verbunden: ${source.name}`, rec ? 'recording' : 'connected');
        updateButtons();
        return;
      }
      if (rec) await stopRecording(manual ? '' : 'Verbindung unterbrochen');
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
    liveRR = [];
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
      if (!source.accFs) {
        $('valRespUnit').textContent = 'kein Sensor';
        respLive.setData({}, 30, 'Beschleunigungssensor nicht verfügbar – keine Atemfrequenz');
      }
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
  async function startRecording() {
    rec = {
      startTime: Date.now(),
      device: source.name,
      maxSamples: settings.duration * FS,
      ecg: [], rr: [], rrT: [], rrElapsed: 0, lost: 0,
      acc: [], accFs: null
    };
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch (_) { wakeLock = null; }
    timerHandle = setInterval(updateTimer, 250);
    updateTimer();
    setStatus('Aufnahme läuft', 'recording');
    updateButtons();
  }

  function updateTimer() {
    const s = rec ? rec.ecg.length / FS : 0;
    const left = rec ? Math.max(0, settings.duration - s) : 0;
    $('timer').textContent = rec
      ? `${fmtClock(s)} / −${fmtClock(left)}`
      : '00:00';
  }

  function fmtClock(s) {
    const t = Math.floor(s);
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  }

  async function stopRecording(reason) {
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
    const stats = Hrv.compute(r.rr);
    const acc = Int16Array.from(r.acc);
    const resp = Resp.analyze(acc, r.accFs);
    const ecg = Int32Array.from(r.ecg);
    const ana = EkgAnalysis.analyze(ecg, FS);
    const meta = {
      startTime: r.startTime,
      duration,
      device: r.device,
      meanHR: stats ? stats.meanHR : null,
      rmssd: stats ? stats.rmssd : null,
      respRate: resp ? resp.rate : null,
      analysis: ana ? { level: ana.level, ectopic: ana.counts.S + ana.counts.V } : null,
      lost: r.lost,
      note: reason || (r.interrupted ? 'Verbindung kurz unterbrochen' : '')
    };
    const data = {
      fs: FS, ecg, rr: Float32Array.from(r.rr), rrT: Float32Array.from(r.rrT),
      acc, accFs: r.accFs
    };
    const id = await store.save(meta, data);
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
      const af = m.respRate ? ` · AF ${Math.round(m.respRate)} /min` : '';
      const es = m.analysis && m.analysis.ectopic ? ` · ${m.analysis.ectopic} Extraschl.` : '';
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
      li.querySelector('.rec-meta').textContent =
        `${EkgExport.fmtDuration(m.duration)} · ${hr}${rmssd}${af}${es}${m.note ? ' · ' + m.note : ''}`;
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
    current = {
      ...r,
      stats: Hrv.compute(Array.from(r.data.rr)),
      resp: Resp.analyze(r.data.acc, r.data.accFs),
      analysis: EkgAnalysis.analyze(r.data.ecg, r.data.fs)
    };
    $('review').hidden = false;
    $('reviewTitle').textContent = `Aufnahme vom ${new Date(r.meta.startTime).toLocaleString('de-DE')}`;
    $('reviewNote').value = r.meta.note || '';
    renderStats();
    renderAnalysis();
    showReviewData();
    $('review').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function showReviewData() {
    if (!current) return;
    const { data, meta, stats } = current;
    review.setScale({ speed: settings.speed, gain: settings.gain, pxPerMm: settings.pxPerMm });
    review.setData(EkgFilters.filtfilt(data.ecg, data.fs, settings));
    tacho.setData(Array.from(data.rrT), Array.from(data.rr), stats ? stats.valid : [], meta.duration);
    respReview.setData(current.resp || {}, meta.duration, 'Keine Atemdaten in dieser Aufnahme');
    $('btnCsvResp').disabled = !current.resp;
    const a = current.analysis;
    review.setAnnotations(a ? {
      beats: a.beats.filter(b => 'SVA'.includes(b.type)),
      bad: a.quality.segments
    } : null);
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

  const QUALITY_NAMES = { flat: 'kein Signal', motion: 'Bewegung', noise: 'Störung' };

  function renderAnalysis() {
    const a = current.analysis;
    const box = $('analysisBox');
    $('anaDot').dataset.level = a ? a.level : 'info';
    $('anaHeadline').textContent = a ? `Automatische Auswertung: ${a.headline}` : 'Automatische Auswertung: Aufnahme zu kurz';
    box.querySelector('.analysis-grid').hidden = !a;
    const ul = $('anaFindings');
    ul.innerHTML = '';
    if (!a) return;
    for (const f of a.findings) {
      const li = document.createElement('li');
      li.dataset.level = f.level;
      li.textContent = f.text;
      ul.appendChild(li);
    }

    const t = a.times;
    const ms = v => (v == null ? '–' : `${Math.round(v)} ms`);
    fillDl($('anaTimes'), [
      ['PQ (120–200)', ms(t && t.pq)],
      ['QRS (< 120)', ms(t && t.qrs)],
      ['QT', ms(t && t.qt)],
      ['QTc Bazett (< 460)', ms(t && t.qtcB)],
      ['QTc Fridericia', ms(t && t.qtcF)],
      ['RR (Median)', ms(a.rhythm.medianRR)]
    ]);
    $('beatLegend').textContent = t ? `Durchschnittsschlag aus ${a.avgCount} Schlägen` : 'Durchschnittsschlag';
    beatChart.setData(t, a.fs);

    // Ereignisliste: Extraschläge und gestörte Abschnitte
    const events = [
      ...a.beats.filter(b => 'SVA'.includes(b.type)).map(b => ({ t: b.i / a.fs, tag: b.type, text: EkgAnalysis.TYPE_NAMES[b.type] })),
      ...a.quality.segments.map(s => ({ t: s.start / a.fs, tag: 'U', text: QUALITY_NAMES[s.type] }))
    ].sort((x, y) => x.t - y.t);
    const wrap = $('anaEvents');
    wrap.innerHTML = '';
    if (!events.length) wrap.textContent = 'keine';
    const MAX = 60;
    for (const e of events.slice(0, MAX)) {
      const b = document.createElement('button');
      b.innerHTML = `<span class="tag ${e.tag}">${e.tag === 'U' ? '!' : e.tag}</span>`;
      b.append(`${e.t.toFixed(1).replace('.', ',')} s ${e.text}`);
      b.onclick = () => review.scrollToTime(e.t);
      wrap.appendChild(b);
    }
    if (events.length > MAX) wrap.append(` … und ${events.length - MAX} weitere`);
  }

  function renderStats() {
    const { meta, stats, resp } = current;
    const f = (v, d = 0) => (v == null ? '–' : v.toFixed(d).replace('.', ','));
    const rows = [
      ['Dauer', EkgExport.fmtDuration(meta.duration)],
      ['Ø Herzfrequenz', stats ? `${f(stats.meanHR)} /min` : '–'],
      ['Min / Max', stats ? `${f(stats.minHR)} / ${f(stats.maxHR)} /min` : '–'],
      ['SDNN', stats ? `${f(stats.sdnn)} ms` : '–'],
      ['RMSSD', stats ? `${f(stats.rmssd)} ms` : '–'],
      ['pNN50', stats ? `${f(stats.pnn50, 1)} %` : '–'],
      ['Schläge / Artefakte', stats ? `${stats.beats} / ${stats.artifacts}` : '–'],
      ['Atemfrequenz', resp && resp.rate ? `${f(resp.rate, 1)} /min` : '–'],
      ['Atemzüge', resp ? String(resp.breaths) : '–'],
      ['Gerät', meta.device]
    ];
    if (meta.lost) rows.push(['Verlorene Werte', String(meta.lost)]);
    const dl = $('reviewStats');
    dl.innerHTML = '';
    for (const [k, v] of rows) {
      const div = document.createElement('div');
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      div.append(dt, dd);
      dl.appendChild(div);
    }
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

  function bindControls() {
    $('selSpeed').value = settings.speed;
    $('selGain').value = settings.gain;
    $('chkHp').checked = settings.highpass;
    $('chkNotch').checked = settings.notch;
    $('rngScale').value = settings.pxPerMm;
    $('selCsv').value = settings.csv;
    $('selDuration').value = settings.duration;

    $('selSpeed').onchange = e => { settings.speed = +e.target.value; saveSettings(); applyView(); };
    $('selGain').onchange = e => { settings.gain = +e.target.value; saveSettings(); applyView(); };
    $('rngScale').oninput = e => { settings.pxPerMm = +e.target.value; saveSettings(); applyView(); };
    $('selCsv').onchange = e => { settings.csv = e.target.value; saveSettings(); };
    $('selDuration').onchange = e => { settings.duration = +e.target.value; saveSettings(); };
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
    $('btnCsvEcg').onclick = () => current && EkgExport.ecgCsv(current, settings.csv);
    $('btnCsvRr').onclick = () => current && EkgExport.rrCsv(current, settings.csv);
    $('btnTxtRr').onclick = () => current && EkgExport.rrTxt(current);
    $('btnCsvResp').onclick = () => current && current.resp && EkgExport.respCsv(current, current.resp, settings.csv);
    $('btnPdf').onclick = async () => {
      if (!current) return;
      const btn = $('btnPdf');
      btn.disabled = true;
      btn.textContent = 'PDF wird erstellt …';
      try {
        await EkgExport.pdfReport(current, current.stats, viewOpts(), current.resp, current.analysis);
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
    bindControls();
    applyView();
    updateButtons();
    await renderList();
  }

  init();
})();
