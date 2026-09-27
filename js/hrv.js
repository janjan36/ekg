/* RR-Intervall-Auswertung: Artefakterkennung und HRV-Kennwerte (Zeitbereich). */
(function (global) {
  'use strict';

  const RR_MIN = 300;   // ms  (= 200 /min)
  const RR_MAX = 2000;  // ms  (= 30 /min)
  const MAX_DEVIATION = 0.2;

  function median(values) {
    const s = values.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  // Ein RR-Intervall gilt als gültig, wenn es im physiologischen Bereich liegt und
  // nicht mehr als 20 % vom lokalen Median (5er-Fenster) abweicht.
  function validateRR(rr) {
    return rr.map((v, i) => {
      if (v < RR_MIN || v > RR_MAX) return false;
      const win = rr.slice(Math.max(0, i - 2), i + 3).filter(x => x >= RR_MIN && x <= RR_MAX);
      const med = median(win);
      return Math.abs(v - med) <= MAX_DEVIATION * med;
    });
  }

  function compute(rr) {
    if (!rr || rr.length < 2) return null;
    const valid = validateRR(rr);
    const nn = rr.filter((_, i) => valid[i]);
    if (nn.length < 2) return null;

    const meanRR = nn.reduce((a, b) => a + b, 0) / nn.length;
    const sdnn = Math.sqrt(nn.reduce((a, v) => a + (v - meanRR) ** 2, 0) / (nn.length - 1));

    // Sukzessive Differenzen nur zwischen zwei direkt aufeinanderfolgenden gültigen Schlägen.
    let sumSq = 0, pairs = 0, over50 = 0;
    for (let i = 1; i < rr.length; i++) {
      if (!valid[i] || !valid[i - 1]) continue;
      const d = rr[i] - rr[i - 1];
      sumSq += d * d;
      pairs++;
      if (Math.abs(d) > 50) over50++;
    }

    return {
      beats: rr.length,
      artifacts: rr.length - nn.length,
      meanRR,
      meanHR: 60000 / meanRR,
      minHR: 60000 / Math.max(...nn),
      maxHR: 60000 / Math.min(...nn),
      sdnn,
      rmssd: pairs ? Math.sqrt(sumSq / pairs) : null,
      pnn50: pairs ? 100 * over50 / pairs : null,
      valid
    };
  }

  global.Hrv = { compute, validateRR };
})(window);
