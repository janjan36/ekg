/* Geführte Messungen: Orthostase-Test, Tiefe Atmung (E/I), HRV-Biofeedback, Resonanzfrequenz-Suche.
 * Enthält die Abläufe (Phasen mit Anweisung und Atemtakt) und die Auswertung aus der gespeicherten Aufnahme.
 * Normwerte nach Ewing (1985) bzw. gängigen Altersrichtwerten – Näherungen, keine Diagnose. */
(function (global) {
  'use strict';

  /* ---------- Abläufe ---------- */
  const RESONANCE_RATES = [6.5, 6, 5.5, 5, 4.5];

  function protocol(type, opts = {}) {
    switch (type) {
      case 'orthostatic':
        return {
          type, name: 'Orthostase-Test',
          phases: [
            { id: 'lie', dur: 120, title: 'Liegen', text: 'Ruhig auf dem Rücken liegen, nicht sprechen, nicht bewegen.' },
            { id: 'stand', dur: 180, title: 'Aufstehen!', text: 'Jetzt zügig aufstehen und ruhig stehen bleiben.', event: 'stand', alert: true, detectStand: true }
          ]
        };
      case 'deepBreathing':
        return {
          type, name: 'Tiefe Atmung (E/I)',
          phases: [
            { id: 'rest', dur: 30, title: 'Vorbereitung', text: 'Aufrecht sitzen, normal atmen. Gleich startet der Atemtakt.' },
            { id: 'paced', dur: 60, title: 'Tief atmen', text: 'Tief und gleichmäßig atmen: 5 s ein, 5 s aus.', event: 'paced', alert: true,
              pacer: { rate: 6, inhale: 0.5 } }
          ]
        };
      case 'biofeedback': {
        const rate = opts.rate || 6;
        return {
          type, name: 'HRV-Biofeedback', params: { rate, minutes: opts.minutes || 5 },
          phases: [
            { id: 'paced', dur: (opts.minutes || 5) * 60, title: `Atmen mit ${fmtRate(rate)} /min`,
              text: 'Entspannt durch die Nase ein, länger durch den Mund aus. Nicht pressen.', event: 'paced',
              pacer: { rate, inhale: 0.4 } }
          ]
        };
      }
      case 'resonance':
        return {
          type, name: 'Resonanzfrequenz-Suche',
          phases: RESONANCE_RATES.map(rate => ({
            id: 'r' + rate, dur: 120, title: `${fmtRate(rate)} Atemzüge/min`,
            text: 'Dem Kreis folgen: einatmen, wenn er wächst, ausatmen, wenn er kleiner wird.',
            event: 'rate', value: rate, alert: true, pacer: { rate, inhale: 0.4 }
          }))
        };
    }
    return null;
  }

  const fmtRate = r => String(r).replace('.', ',');
  const f1 = v => (v == null ? '–' : v.toFixed(1).replace('.', ','));
  const f2 = v => (v == null ? '–' : v.toFixed(2).replace('.', ','));
  const f0 = v => (v == null ? '–' : String(Math.round(v)));

  /* ---------- Atemtakt ---------- */
  // Phase im Atemzyklus: { inhale: bool, p: 0..1 innerhalb der Teilphase, secsLeft }
  function pacerState(elapsed, pacer) {
    const cycle = 60 / pacer.rate, tin = cycle * pacer.inhale;
    const c = elapsed % cycle;
    return c < tin
      ? { inhale: true, p: c / tin, secsLeft: tin - c, level: ease(c / tin) }
      : { inhale: false, p: (c - tin) / (cycle - tin), secsLeft: cycle - c, level: 1 - ease((c - tin) / (cycle - tin)) };
  }
  const ease = x => 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, x)));

  /* ---------- Hilfen für die Auswertung ---------- */
  // Schläge aus der EKG-Auswertung: { t (s), rr (ms), hr, ok }
  function beatSeries(ana) {
    const out = [];
    if (!ana) return out;
    const b = ana.beats;
    for (let k = 1; k < b.length; k++) {
      const rr = (b[k].i - b[k - 1].i) * 1000 / ana.fs;
      const ok = b[k].type === 'N' && b[k - 1].type === 'N' && rr > 300 && rr < 2000;
      out.push({ t: b[k].i / ana.fs, rr, hr: 60000 / rr, ok });
    }
    return out;
  }

  const avg = v => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
  const eventTime = (events, id) => { const e = events.find(x => x.id === id); return e ? e.t : null; };

  // Schwankungsbreite der HF je Atemzyklus (max − min) und E/I-Verhältnis (längstes/kürzestes RR)
  function cycleSwings(beats, start, end, rate) {
    const cycle = 60 / rate, out = [];
    for (let c0 = start; c0 + cycle <= end + 0.01; c0 += cycle) {
      // 1 s Versatz: die Herzfrequenz folgt der Atmung mit kurzer Verzögerung
      const w = beats.filter(x => x.ok && x.t >= c0 + 1 && x.t < c0 + cycle + 1);
      if (w.length < 4) continue;
      const hrs = w.map(x => x.hr), rrs = w.map(x => x.rr);
      out.push({ dHR: Math.max(...hrs) - Math.min(...hrs), ei: Math.max(...rrs) / Math.min(...rrs) });
    }
    return out;
  }

  // Untere Grenze des E/I-Verhältnisses nach Alter (Richtwerte)
  function eiLowerLimit(age) {
    const table = [[24, 1.17], [29, 1.15], [34, 1.13], [39, 1.12], [44, 1.10], [49, 1.08], [54, 1.07], [59, 1.06], [64, 1.04], [69, 1.03], [200, 1.02]];
    if (!age) return null;
    return table.find(([a]) => age <= a)[1];
  }

  function rating(level, text) { return { level, text }; }

  /* ---------- Auswertungen ---------- */
  function evalOrthostatic(ctx) {
    const beats = beatSeries(ctx.ana);
    const standT = eventTime(ctx.events, 'standDetected') ?? eventTime(ctx.events, 'stand');
    if (standT == null) return { error: 'Zeitpunkt des Aufstehens fehlt.' };
    const base = avg(beats.filter(x => x.ok && x.t >= standT - 65 && x.t < standT - 5).map(x => x.hr));
    const after = beats.filter(x => x.t > standT);
    const okIn = (from, to) => after.slice(from, to).filter(x => x.ok);
    const b15 = okIn(4, 25), b30 = okIn(19, 40);
    const ratio = b15.length && b30.length ? Math.max(...b30.map(x => x.rr)) / Math.min(...b15.map(x => x.rr)) : null;
    const first30 = after.filter(x => x.ok && x.t < standT + 30);
    const maxHR = first30.length ? Math.max(...first30.map(x => x.hr)) : null;
    const hr1 = avg(after.filter(x => x.ok && x.t >= standT + 50 && x.t < standT + 70).map(x => x.hr));
    const endT = Math.max(...beats.map(x => x.t));
    const hr3 = avg(after.filter(x => x.ok && x.t >= endT - 30).map(x => x.hr));
    const dMax = maxHR != null && base != null ? maxHR - base : null;
    const d3 = hr3 != null && base != null ? hr3 - base : null;

    const findings = [];
    if (ratio == null) findings.push(rating('info', '30:15-Verhältnis nicht bestimmbar (zu wenige saubere Schläge).'));
    else if (ratio >= 1.04) findings.push(rating('ok', `30:15-Verhältnis ${f2(ratio)} – normal (≥ 1,04).`));
    else if (ratio > 1.0) findings.push(rating('info', `30:15-Verhältnis ${f2(ratio)} – grenzwertig (1,01–1,03).`));
    else findings.push(rating('warn', `30:15-Verhältnis ${f2(ratio)} – erniedrigt (≤ 1,00).`));
    if (d3 != null) {
      if (d3 >= 30) findings.push(rating('warn', `Herzfrequenz im Stehen um ${f0(d3)} /min erhöht – deutlicher Anstieg (≥ 30 /min). Bei Beschwerden ärztlich abklären.`));
      else findings.push(rating('ok', `Anstieg der Herzfrequenz nach 3 min Stehen: ${f0(d3)} /min (typisch 10–20).`));
    }
    if (eventTime(ctx.events, 'standDetected') == null) {
      findings.push(rating('info', 'Aufstehen nicht über den Lagesensor erkannt – Zeitpunkt der Aufforderung verwendet.'));
    }
    return {
      rows: [
        ['Ruhepuls liegend', `${f0(base)} /min`],
        ['Max. HF (30 s)', `${f0(maxHR)} /min`],
        ['Anstieg max.', `${f0(dMax)} /min`],
        ['HF nach 1 min', `${f0(hr1)} /min`],
        ['HF nach 3 min', `${f0(hr3)} /min`],
        ['30:15-Verhältnis (≥ 1,04)', f2(ratio)]
      ],
      findings,
      key: { ratio3015: ratio, dHR3: d3 },
      chart: { beats, marks: [{ t: standT, label: 'Aufstehen' }] }
    };
  }

  function evalDeepBreathing(ctx) {
    const beats = beatSeries(ctx.ana);
    const start = eventTime(ctx.events, 'paced');
    if (start == null) return { error: 'Beginn der Atemphase fehlt.' };
    const cycles = cycleSwings(beats, start, start + 60, 6);
    const dHR = avg(cycles.map(c => c.dHR)), ei = avg(cycles.map(c => c.ei));
    const limit = eiLowerLimit(ctx.age);
    const findings = [];
    if (dHR == null) findings.push(rating('info', 'Nicht auswertbar (zu wenige saubere Atemzyklen).'));
    else if (dHR >= 15) findings.push(rating('ok', `Herzfrequenz-Schwankung ${f0(dHR)} /min – normal (≥ 15).`));
    else if (dHR > 10) findings.push(rating('info', `Herzfrequenz-Schwankung ${f0(dHR)} /min – grenzwertig (11–14).`));
    else findings.push(rating('warn', `Herzfrequenz-Schwankung ${f0(dHR)} /min – erniedrigt (≤ 10).`));
    if (ei != null && limit != null) {
      findings.push(ei >= limit
        ? rating('ok', `E/I-Verhältnis ${f2(ei)} – im Richtbereich für ${ctx.age} Jahre (≥ ${f2(limit)}).`)
        : rating('info', `E/I-Verhältnis ${f2(ei)} – unter dem Richtwert für ${ctx.age} Jahre (${f2(limit)}).`));
    } else if (ei != null) {
      findings.push(rating('info', 'Für die Einordnung des E/I-Verhältnisses das Alter eingeben.'));
    }
    return {
      rows: [
        ['Auswertbare Zyklen', `${cycles.length} von 6`],
        ['HF-Schwankung Ø (≥ 15)', `${f0(dHR)} /min`],
        ['E/I-Verhältnis Ø', f2(ei)],
        ['Richtwert E/I', limit ? `≥ ${f2(limit)} (${ctx.age} J.)` : 'Alter fehlt']
      ],
      findings,
      key: { dHR, ei },
      chart: { beats, marks: [{ t: start, label: 'Atemtakt' }, { t: start + 60, label: 'Ende' }] }
    };
  }

  // Kohärenz über gleitende 64-s-Fenster (alle 5 s) eines Abschnitts
  function coherenceTrack(beats, start, end) {
    const out = [];
    for (let t = start + 64; t <= end + 0.01; t += 5) {
      const win = beats.filter(x => x.t > t - 64 && x.t <= t).map(x => ({ t: x.t, rr: x.rr }));
      const c = global.HrvX.coherence(win);
      if (c) out.push({ t, score: c.score, perMin: c.perMin });
    }
    return out;
  }

  function evalBiofeedback(ctx) {
    const beats = beatSeries(ctx.ana);
    const start = eventTime(ctx.events, 'paced') ?? 0;
    const end = Math.max(...beats.map(x => x.t));
    const rate = (ctx.params && ctx.params.rate) || 6;
    const track = coherenceTrack(beats, start, end);
    const meanCoh = avg(track.map(x => x.score));
    const high = track.length ? 100 * track.filter(x => x.score >= 60).length / track.length : null;
    const swings = cycleSwings(beats, start, end, rate);
    const amp = avg(swings.map(c => c.dHR));
    const findings = [];
    if (meanCoh == null) findings.push(rating('info', 'Zu kurz für die Kohärenz (mindestens gut 1 Minute).'));
    else findings.push(rating(meanCoh >= 60 ? 'ok' : 'info',
      `Kohärenz Ø ${f0(meanCoh)} % – ${meanCoh >= 60 ? 'hoch' : meanCoh >= 30 ? 'mittel' : 'niedrig'}; ${f0(high)} % der Zeit im hohen Bereich (≥ 60 %).`));
    if (amp != null) findings.push(rating('ok', `Herzfrequenz-Schwankung je Atemzug Ø ${f0(amp)} /min.`));
    return {
      rows: [
        ['Atemtakt', `${fmtRate(rate)} /min`],
        ['Kohärenz Ø', `${f0(meanCoh)} %`],
        ['Zeit mit hoher Kohärenz', `${f0(high)} %`],
        ['HF-Schwankung je Atemzug', `${f0(amp)} /min`]
      ],
      findings,
      key: { coherence: meanCoh, amp },
      chart: { beats, marks: [], coherence: track }
    };
  }

  function evalResonance(ctx) {
    const beats = beatSeries(ctx.ana);
    const blocks = ctx.events.filter(e => e.id === 'rate').sort((a, b) => a.t - b.t);
    const end = Math.max(...beats.map(x => x.t));
    const results = blocks.map((e, i) => {
      const bEnd = i + 1 < blocks.length ? blocks[i + 1].t : end;
      const s0 = e.t + 20;   // Einschwingzeit
      const swings = cycleSwings(beats, s0, bEnd, e.value);
      const win = beats.filter(x => x.t >= Math.max(s0, bEnd - 64) && x.t <= bEnd).map(x => ({ t: x.t, rr: x.rr }));
      const coh = global.HrvX.coherence(win);
      return { rate: e.value, amp: avg(swings.map(c => c.dHR)), coherence: coh ? coh.score : null };
    }).filter(r => r.amp != null);
    if (!results.length) return { error: 'Keine auswertbaren Atemblöcke.' };
    const best = results.reduce((a, b) => (b.amp > a.amp ? b : a));
    return {
      rows: results.map(r => [`${fmtRate(r.rate)} /min`, `Schwankung ${f0(r.amp)} /min · Kohärenz ${f0(r.coherence)} %`]),
      findings: [rating('ok', `Deine Resonanzfrequenz liegt bei etwa ${fmtRate(best.rate)} Atemzügen/min – dort schwankt die Herzfrequenz am stärksten. Diesen Takt fürs Biofeedback nutzen.`)],
      key: { resonanceRate: best.rate },
      chart: { beats, marks: blocks.map(e => ({ t: e.t, label: fmtRate(e.value) })) }
    };
  }

  const EVALUATORS = { orthostatic: evalOrthostatic, deepBreathing: evalDeepBreathing, biofeedback: evalBiofeedback, resonance: evalResonance };
  const NAMES = { orthostatic: 'Orthostase-Test', deepBreathing: 'Tiefe Atmung (E/I)', biofeedback: 'HRV-Biofeedback', resonance: 'Resonanzfrequenz-Suche' };

  // ctx: { ana, events, params, age }
  function evaluate(type, ctx) {
    const fn = EVALUATORS[type];
    if (!fn || !ctx.ana) return null;
    try {
      const r = fn(ctx);
      if (r.error) return { name: NAMES[type], error: r.error, rows: [], findings: [rating('info', r.error)] };
      r.name = NAMES[type];
      r.level = r.findings.some(f => f.level === 'warn') ? 'warn' : r.findings.some(f => f.level === 'info') ? 'info' : 'ok';
      return r;
    } catch (err) {
      console.error(err);
      return { name: NAMES[type], error: String(err), rows: [], findings: [rating('info', 'Auswertung fehlgeschlagen.')] };
    }
  }

  global.Tests = { protocol, pacerState, evaluate, beatSeries, coherenceTrack, NAMES, RESONANCE_RATES, fmtRate };
})(window);
