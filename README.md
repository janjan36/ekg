# EKG mit dem Polar H10

Web-App, die das EKG des Polar-H10-Brustgurts live anzeigt, aufzeichnet, speichert und exportiert.
Sie läuft ohne Installation im Browser (Web Bluetooth).

> Kein Medizinprodukt – nur für private Zwecke, keine Diagnose.

## Starten (Windows)

1. Doppelklick auf **`EKG starten.cmd`**.
   Ein schwarzes Fenster öffnet sich (kleiner Webserver, nur auf diesem PC erreichbar), und Edge öffnet
   `http://localhost:8130/`. Das Fenster offen lassen, solange die App benutzt wird.
2. Brustgurt anlegen: **Elektroden anfeuchten**, Sender einklicken.
3. **„Mit Polar H10 verbinden“** → im Dialog „Polar H10 xxxxxxxx“ wählen → „Koppeln“.
4. Nach ein bis zwei Sekunden läuft das EKG. **„Aufnahme starten“** – die Aufnahme stoppt automatisch
   nach der gewählten Dauer oder per Klick.

Ohne Gurt ausprobieren: **„Demo“**.

### Tipps
- Der H10 kann nur mit **einem** Gerät gleichzeitig eine EKG-Verbindung haben:
  Polar-Flow-App, Uhren, Trainings-Apps vorher trennen bzw. schließen.
- Den Gurt **nicht** in den Windows-Bluetooth-Einstellungen koppeln – die Verbindung macht der Browser selbst.
  Falls er dort schon gekoppelt ist und Probleme macht: dort entfernen.
- Nur Chrome oder Edge verwenden (Firefox kann kein Web Bluetooth).
- Fehler? Mit **F12 → Konsole** die roten Meldungen ansehen.

## Funktionen
- **Live-EKG** auf Millimeterpapier, 25 oder 50 mm/s, 5/10/20 mm/mV
- **Filter** nur für die Anzeige: Grundlinie (Hochpass 0,5 Hz) und 50-Hz-Netzbrummen. Gespeichert werden immer die Rohdaten.
- **Herzfrequenz, RR-Intervall, RMSSD** der letzten 60 s, Hautkontakt, Akkustand
- **Atemfrequenz** aus dem Beschleunigungssensor des H10 (Brustkorbbewegung): Live-Wert der letzten 30 s,
  Atemkurve mit markierten Atemzügen. Funktioniert am besten in Ruhe – bei Bewegung ist der Wert unzuverlässig.
- **Automatische Auswertung** (live für die letzten 30 s, ausführlich für jede Aufnahme und im PDF):
  - *Signalqualität*: 2-s-Abschnitte ohne Signal, mit Bewegung oder Störung werden grau markiert und nicht ausgewertet
  - *Rhythmus*: Herzfrequenz, regelmäßig / atemabhängig schwankend / deutlich unregelmäßig
    (Muster wie bei Vorhofflimmern, Kriterien nach Dash et al. 2009), Pausen über 2 s
  - *Extraschläge*: vorzeitige Schläge mit normaler Form = **S** (supraventrikulär), mit abweichender Form = **V**
    (ventrikulär); im EKG markiert, Liste mit Sprung zur Stelle
  - *EKG-Zeiten*: PQ, QRS, QT, QTc (Bazett und Fridericia) am Durchschnittsschlag, mit Bild und Messlinien
  - Alles sind Näherungen aus einer Ableitung mit 130 Hz – **keine Diagnose**. Auffälligkeiten ärztlich abklären lassen.
  - Der Demo-Gurt enthält absichtlich gelegentliche Extraschläge und alle 45 s eine kurze Störung, um die Auswertung zu zeigen.
- **Erweiterte HRV** (je Aufnahme und im PDF): Frequenzspektrum mit LF, HF, LF/HF, VLF (ab 4 min),
  Poincaré-Plot (SD1/SD2), Stress-Index nach Baevsky (√SI, wie Kubios), DFA α1/α2.
  LF und LF/HF erst ab 2 min aussagekräftig. Bei langsamer Atmung (< 9/min) liegt die Atemschwankung im LF-Band.
- **DFA α1 live** (letzte 2 min) fürs Training: > 0,75 unter der aeroben Schwelle, 0,75–0,5 dazwischen,
  < 0,5 über der anaeroben Schwelle (gilt nur bei Ausdauerbelastung).
- **Körperlage und Bewegung** aus dem Beschleunigungssensor (liegend / geneigt / aufrecht, ruhig / Bewegung).
  Mit **Einstellungen → Lage kalibrieren** (im Stehen) werden auch Seitenlage und Zurücklehnen erkannt.
- **Geführte Tests** (Reiter „Tests“, werden als Aufnahme gespeichert und ausgewertet):
  - *Orthostase-Test*: 2 min liegen, 3 min stehen – 30:15-Verhältnis (≥ 1,04 normal), HF-Anstieg.
    Das Aufstehen wird über den Lagesensor erkannt.
  - *Tiefe Atmung*: 1 min mit 6 Atemzügen/min – HF-Schwankung (≥ 15/min normal) und E/I-Verhältnis
    mit Altersrichtwert.
  - *HRV-Biofeedback*: Atemkreis mit wählbarem Takt, Kohärenz live (Anteil der Schwankung im Atemrhythmus).
  - *Resonanzfrequenz finden*: 5 × 2 min mit 6,5 … 4,5 Atemzügen/min; der beste Takt wird fürs Biofeedback vorgewählt.
- **Verlauf** (Reiter „Verlauf“): Herzfrequenz, RMSSD, Atemfrequenz, QTc, LF/HF, Stress-Index und Testwerte über alle
  Aufnahmen, mit persönlichem Normalbereich (Mittelwert ± 1 SD ab 5 Aufnahmen); auch als Tabelle.
- **Aufnahmen** (30 s bis 10 min) werden im Browser gespeichert; Detailansicht mit Scrollen und HF-Verlauf
- **HRV** der Aufnahme: Ø/Min/Max-HF, SDNN, RMSSD, pNN50, Artefaktzahl
  (RR-Intervalle außerhalb 300–2000 ms oder > 20 % Abweichung vom lokalen Median gelten als Artefakt)
- **Export**: EKG als CSV (Zeit, µV), RR als CSV, RR als TXT (für Kubios HRV), Atmung als CSV und
  **PDF-Bericht** (A4 quer, maßstabsgetreue Vektorgrafik, mit Auswertung). Unter Windows als Download,
  auf dem iPhone über das Teilen-Menü (in „Dateien“ sichern, Mail, AirDrop …).

## Wichtig zu den gespeicherten Aufnahmen
Die Aufnahmen liegen im Browser-Speicher des jeweiligen Geräts und der jeweiligen Adresse
(Windows: `localhost:8130`, iPhone: die GitHub-Pages-Adresse in Bluefy). Sie werden **nicht** zwischen
PC und iPhone abgeglichen und nie ins Internet übertragen. Wer die Browserdaten löscht, verliert sie –
wichtige Aufnahmen daher als PDF/CSV exportieren.

## Bildschirm-Maßstab
Unter **Einstellungen** den Regler so einstellen, dass der rote Balken mit dem Lineal gemessen 5 cm lang ist.
Dann entsprechen die Kästchen echten Millimetern (1 kleines Kästchen = 40 ms bzw. 0,1 mV bei Standardeinstellung).

## iPhone
Safari kann kein Web Bluetooth. Die App läuft deshalb im kostenlosen Browser **Bluefy – Web BLE Browser**
(App Store) und wird über **GitHub Pages** (HTTPS) bereitgestellt:
**https://janjan36.github.io/ekg/**

1. Bluefy aus dem App Store installieren.
2. In Bluefy die Adresse oben öffnen und als Lesezeichen/Favorit speichern.
3. Bluefy den Bluetooth-Zugriff erlauben (Abfrage beim ersten Verbinden bzw. iOS-Einstellungen → Bluefy).
4. Gurt anlegen, **„Mit Polar H10 verbinden“**, Gerät wählen.

Tipps:
- Während der Aufnahme das iPhone **entsperrt und Bluefy im Vordergrund** lassen – iOS trennt Bluetooth
  sonst im Hintergrund. Die App hält den Bildschirm während der Aufnahme wach, sofern Bluefy das zulässt.
- Querformat zeigt mehr EKG auf einmal.
- Exporte öffnen das Teilen-Menü: „In Dateien sichern“ legt PDF/CSV in der Dateien-App ab.

## Methoden und Quellen
Die Verfahren folgen etablierter Fachliteratur. Grenzwerte sind Richtwerte aus Studien an Gesunden;
verschiedene Quellen weichen teils voneinander ab.

| Bereich | Grundlage |
|---|---|
| R-Zacken-Erkennung | Pan & Tompkins (1985), IEEE Trans Biomed Eng |
| HRV Zeit- und Frequenzbereich (SDNN, RMSSD, LF 0,04–0,15 Hz, HF 0,15–0,4 Hz) | Task Force der ESC/NASPE (1996), Circulation |
| Poincaré SD1/SD2 | Brennan et al. (2001) |
| Stress-Index | Baevsky; Darstellung als √SI wie in Kubios HRV |
| DFA α1 und Belastungsschwellen (0,75 / 0,5) | Peng et al. (1995); Rogers & Gronwald et al. (2021) |
| Vorhofflimmer-Muster (nRMSSD, Wendepunkte, Shannon-Entropie) | Dash et al. (2009), Ann Biomed Eng |
| QTc | Bazett (1920), Fridericia (1920) |
| Orthostase-Test (30:15), Tiefe Atmung (HF-Differenz ≥ 15 / 11–14 / ≤ 10) | Ewing et al. (1985); Übersicht bei [Kubios](https://www.kubios.com/blog/about-autonomic-nervous-system-function-analysis/) |
| E/I-Untergrenze nach Alter: 1 + exp(−1,12 − 0,0198 · Alter) | zitiert in [arXiv:1901.05071](https://arxiv.org/pdf/1901.05071) |
| Resonanzfrequenz-Atmung / Biofeedback | Lehrer et al. (2000, 2013); Kohärenz hier vereinfacht als Leistungsanteil um den Spektralgipfel |

## Technik
- Reines HTML/CSS/JavaScript ohne Bibliotheken, kein Build-Schritt
- Polar Measurement Data (PMD) Service `FB005C80-…`: ECG 130 Hz, 14 bit, Werte in µV
- PMD ACC: 25 Hz, 16 bit, ±2 g (mG). Atmung: Bandpass 0,08–0,7 Hz je Achse, Projektion auf die
  Hauptbewegungsrichtung, Atemzüge = Maxima mit Hysterese, Frequenz aus dem Median der Atemzugabstände
- Heart Rate Service (`0x180D`) für HF und RR, Battery Service (`0x180F`)

| Datei | Inhalt |
|---|---|
| `index.html`, `css/style.css` | Oberfläche |
| `js/polar.js` | Bluetooth-Verbindung und Protokoll des H10 |
| `js/demo.js` | Simulierter Gurt |
| `js/ecgChart.js` | EKG-Darstellung (Live, Aufnahme, HF-Verlauf) |
| `js/filters.js` | Anzeige-Filter |
| `js/hrv.js` | Artefakterkennung und HRV-Werte |
| `js/resp.js` | Atemfrequenz aus dem Beschleunigungssensor |
| `js/analysis.js` | Automatische Auswertung (R-Zacken, Signalqualität, Schlagtypen, Rhythmus, EKG-Zeiten) |
| `js/hrvx.js` | Erweiterte HRV: Spektrum, Poincaré, Stress-Index, DFA, Kohärenz |
| `js/posture.js` | Körperlage und Bewegung, Erkennung des Aufstehens |
| `js/tests.js`, `js/testRunner.js` | Geführte Tests: Abläufe, Atemtakt, Auswertung mit Normwerten |
| `js/charts2.js` | Spektrum, Poincaré, HF-Verlauf, Verlaufskurven |
| `js/trends.js` | Kennwerte je Aufnahme und Verlaufsansicht |
| `js/storage.js` | Speicherung im Browser (IndexedDB) |
| `js/export.js` | CSV/TXT-Export und PDF-Bericht, Teilen-Menü auf iOS |
| `js/pdf.js` | Kleiner PDF-Erzeuger (Vektorgrafik, Helvetica) |
| `icon.svg`, `icon-180.png` | App-Symbol |
| `js/app.js` | Steuerung |
| `server.ps1`, `EKG starten.cmd` | Lokaler Webserver |
