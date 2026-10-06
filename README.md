# EKG mit dem Polar H10

Web-App, die das EKG des Polar-H10-Brustgurts live anzeigt, aufzeichnet, speichert und exportiert.
Sie läuft ohne Installation im Browser (Web Bluetooth). Ausgelegt für **Ruhe-EKGs** (liegend oder sitzend),
nicht für Messungen unter Belastung.

> Kein Medizinprodukt – nur für private Zwecke, keine Diagnose.

## Starten (Windows)

1. Doppelklick auf **`EKG starten.cmd`**.
   Ein schwarzes Fenster öffnet sich (kleiner Webserver, nur auf diesem PC erreichbar), und Edge öffnet
   `http://localhost:8130/`. Das Fenster offen lassen, solange die App benutzt wird.
2. Brustgurt anlegen: **Elektroden anfeuchten**, Sender einklicken.
3. **„Mit Polar H10 verbinden“** → im Dialog „Polar H10 xxxxxxxx“ wählen → „Koppeln“.
4. Nach ein bis zwei Sekunden läuft das EKG. **Situation** wählen (Ruhe liegend oder Ruhe sitzend),
   dann **„Aufnahme starten“** – die Aufnahme stoppt automatisch nach der gewählten Dauer oder per Klick.
   Bei Beschwerden (Herzstolpern, Herzrasen, Schwindel) während der Aufnahme **„Symptom markieren“** tippen.

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
- **Automatische Auswertung** (live für die letzten 30 s, ausführlich für jede Aufnahme und im PDF):
  - *Symptome*: Für jedes markierte Symptom zeigt die Auswertung, was der Rhythmus von 10 s davor bis 5 s danach
    zeigt (Extraschläge, Pausen, Frequenz). Ein solcher symptombezogener Streifen ist ärztlich am besten verwertbar.
  - *Signalqualität*: 2-s-Abschnitte ohne Signal, mit Bewegung oder Störung werden grau markiert und nicht ausgewertet.
    Verlorene Bluetooth-Pakete und Verbindungsabbrüche werden als *Übertragungslücke* eingefügt (nicht überbrückt),
    damit die Zeitachse stimmt.
  - *Rhythmus*: Herzfrequenz, regelmäßig / atemabhängig schwankend / deutlich unregelmäßig
    (Muster wie bei Vorhofflimmern, Kriterien nach Dash et al. 2009), Pausen über 2 s
  - *Extraschläge*: vorzeitige Schläge mit normaler Form = **S** (supraventrikulär); vorzeitig mit abweichender
    Form oder breiter – bzw. auch ohne Vorzeitigkeit deutlich breiter und anders geformt – = **V** (ventrikulär);
    im EKG markiert, Liste mit Sprung zur Stelle
  - *Muster*: Couplets (2 in Folge), Salven (≥ 3 in Folge; ventrikulär = nicht anhaltende Kammertachykardie möglich),
    Bigeminus/Trigeminus, ausgefallene Schläge (Abstand ≈ doppelt, vom Gurt bestätigt – Hinweis auf SA-/AV-Block II°),
    plötzliches Herzrasen (Sprung um > 30/min auf > 150/min innerhalb eines Schlags)
  - *Hinweise*: regelmäßig um 150/min in Ruhe (auch Vorhofflattern möglich), schnell mit breitem QRS
    (Kammertachykardie möglich), sehr langsam mit breitem QRS (AV-Block III° möglich)
  - *EKG-Zeiten*: PQ, QRS, QT, QTc (Fridericia, Bazett zum Vergleich) und Amplituden am Durchschnittsschlag
    (nur Schläge mit ähnlichem Abstand), mit Bild, Messlinien und Gipfelpunkten P, Q, R, S, T
  - Alles sind Näherungen aus einer Ableitung mit 130 Hz – **keine Diagnose**. Bei Auffälligkeiten rät die App,
    den PDF-Streifen ärztlich befunden zu lassen (nach ESC-Leitlinie 2024 reicht dafür ein ≥ 30-s-Einkanal-EKG).
    Eine pauschale Entwarnung gibt es nicht: ohne Befund heißt es „Keine Auffälligkeiten erkannt (automatisch)“.
  - **Nicht erkennbar** sind Herzinfarkt und Durchblutungsstörungen (ST-Strecke), Lagetyp, Hypertrophie,
    Schenkelblock-Typ und Schrittmacherfunktion. Bei Herzschrittmacher ist die Auswertung unzuverlässig.
  - Der Demo-Gurt enthält absichtlich gelegentliche Extraschläge, alle 45 s eine kurze Störung und etwa alle 95 s
    ein verlorenes Datenpaket, um die Auswertung zu zeigen.
- **Erweiterte HRV** (je Aufnahme und im PDF): Frequenzspektrum mit LF, HF, LF/HF,
  Poincaré-Plot (SD1/SD2), Stress-Index nach Baevsky (√SI, wie Kubios), DFA α1 (in Ruhe meist um 1;
  ab 5 % korrigierten Intervallen kein Wert, Rogers et al. 2021).
  LF und LF/HF erst ab 2 min aussagekräftig (Task Force), für Vergleiche 5 min. Kein VLF (aus Kurzzeitmessungen
  laut Task Force zu vermeiden). LF/HF hängt stark von der Atmung ab und ist als „Stressbalance“ umstritten.
  Bei unregelmäßigem Rhythmus (Vorhofflimmer-Muster) werden keine HRV-Werte berechnet.
- **Verlauf** (Reiter „Verlauf“): Herzfrequenz, RMSSD, QTc, LF/HF und Stress-Index über alle Aufnahmen, filterbar
  nach Lage (liegend/sitzend), mit persönlichem Normalbereich (Mittelwert ± 1 SD ab 5 Aufnahmen); auch als Tabelle.
  HRV-Werte erst ab 2 min Aufnahmedauer. Demo-Aufnahmen zählen nicht mit. Liegen Ruhe-Herzfrequenz über und RMSSD
  unter dem Normalbereich, weist die Aufnahme darauf hin (passt oft zu Infekt, Übertraining, Schlafmangel).
- **Aufnahmen** (30 s bis 10 min) werden im Browser gespeichert; Detailansicht mit Scrollen, 1-mV-Eichzacke und
  HF-Verlauf. Die Situation lässt sich dort nachträglich ändern.
- **HRV** der Aufnahme: Ø/Min/Max-HF, SDNN, RMSSD, pNN50 und Anteil korrigierter Intervalle.
  Artefaktkorrektur nach Lipponen & Tarvainen (2019) wie in Kubios: Extraschläge, zu lange/kurze, fehlende und
  zusätzliche Schläge werden erkannt und für die HRV ersetzt (NN- statt RR-Intervalle).
- **Export**: EKG als CSV (Zeit, µV), RR als CSV, RR als TXT (unkorrigiert, für Kubios HRV),
  **EKG als EDF+** (Rohdaten in µV mit Annotationen für Symptome, Übertragungslücken und Extraschläge –
  z. B. für EDFbrowser; ohne persönliche Angaben im Dateikopf) und
  **PDF-Bericht** (A4 quer, maßstabsgetreue Vektorgrafik mit Eichzacke, Abtastrate, Filtern, Symptomen und Auswertung).
  Unter Windows als Download, auf dem iPhone über das Teilen-Menü (in „Dateien“ sichern, Mail, AirDrop …).

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

## Wie belastbar sind die Werte?

| Verlässlichkeit | Werte |
|---|---|
| **Gut** (RR-Intervalle des H10, validiert) | Herzfrequenz, RR, RMSSD |
| **Eingeschränkt** | HF/LF-Leistung (stark atemabhängig), LF/HF (als „Stressbalance“ umstritten), SDNN (dauerabhängig), Extraschläge und Muster (S/V nur über die Form einer Ableitung), Vorhofflimmer-Hinweis (eigener, nicht klinisch validierter Algorithmus; erst ab ~100 Schlägen), Vorhofflattern (allein über die Frequenz kaum erkennbar), Signalqualität |
| **Nicht möglich** | Herzinfarkt/Ischämie (ST-Strecke), Lagetyp, Hypertrophie, Schenkelblock-Typ, Schrittmacherimpulse (bei 130 Hz nicht sichtbar) |
| **Nur Orientierung / eigener Verlauf** | QT/QTc, PQ, QRS-Breite und Amplituden (eine nicht standardisierte Brustgurt-Ableitung mit 130 Hz statt 12 Ableitungen mit ≥ 500 Hz), Stress-Index, DFA α1 in Ruhe |

QTc wird nach **Fridericia** bewertet (Bazett überkorrigiert bei hoher Frequenz), Grenze nach AHA/ACCF/HRS 2009:
Männer 450, Frauen 460 ms; bei > 100/min oder unregelmäßigem Rhythmus keine Bewertung.
Pausen und ausgefallene Schläge werden nur gemeldet, wenn auch die RR-Messung des Gurts sie bestätigt.
Bewusst abweichend von manchen Lehrbüchern: Bradykardie erst unter 50/min (ACC/AHA/HRS 2018, vermeidet
Fehlalarme bei Trainierten), „QTc kurz“ erst unter 340 ms (das T-Wellen-Ende ist beim Gurt zu ungenau für 390 ms).
Demo-Aufnahmen erscheinen nicht im Verlauf.

### Prüfung an der MIT-BIH-Arrhythmie-Datenbank
Die automatische Auswertung wurde an der MIT-BIH-Arrhythmia-Database (PhysioNet; 48 Halbstunden-Aufnahmen,
von Kardiologen Schlag für Schlag annotiert) geprüft. Die Daten wurden dafür wie beim H10 auf 130 Hz
heruntergerechnet; ausgewertet wurde die erste Ableitung (meist MLII). Zuordnung innerhalb 150 ms (AAMI EC57).

| Ergebnis (44 Aufnahmen ohne Schrittmacher) | Sensitivität | Positiver Vorhersagewert |
|---|---|---|
| Schlagerkennung (R-Zacken) | 99,3 % | 99,3 % |
| Ventrikuläre Extraschläge (V) | 76 % | 86 % |

Einschränkungen: Die Datenbank enthält überwiegend Kranke mit vielen Rhythmusstörungen, und ihre Ableitung
entspricht nicht der des Brustgurts. Schwierig sind stark gestörte Aufnahmen, Schenkelblöcke und Vorhofflattern.
Die Werte zeigen, dass die Erkennung grundsätzlich funktioniert – eine klinische Validierung mit dem H10 ersetzen
sie nicht. Supraventrikuläre Extraschläge (S) und das Vorhofflimmer-Muster wurden nicht gesondert geprüft.

## Methoden und Quellen
Die Verfahren folgen etablierter Fachliteratur. Grenzwerte sind Richtwerte aus Studien an Gesunden;
verschiedene Quellen weichen teils voneinander ab.

| Bereich | Grundlage |
|---|---|
| R-Zacken-Erkennung | Pan & Tompkins (1985), IEEE Trans Biomed Eng |
| HRV Zeit- und Frequenzbereich (SDNN, RMSSD, LF 0,04–0,15 Hz, HF 0,15–0,4 Hz) | Task Force der ESC/NASPE (1996), Circulation |
| RR-Artefaktkorrektur | Lipponen & Tarvainen (2019), J Med Eng Technol |
| DFA α1 und Artefaktanteil | Rogers et al. (2021), Sensors |
| Vorhofflimmern: ärztliche Befundung eines ≥ 30-s-Streifens | ESC-Leitlinie Vorhofflimmern (2024) |
| Aussagekraft des H10-EKGs, Vorsicht bei Schrittmacher und Vorhofflattern | Skála et al. (2022), Cor et Vasa; Gilgen-Ammann et al. (2019) |
| Poincaré SD1/SD2 | Brennan et al. (2001) |
| Stress-Index | Baevsky; Darstellung als √SI wie in Kubios HRV |
| DFA α1 | Peng et al. (1995) |
| Symptombezogene Aufzeichnung | ESC-Leitlinie Vorhofflimmern (2024) |
| EDF+-Format | Kemp & Olivan (2003), Clin Neurophysiol |
| Prüfdaten | MIT-BIH Arrhythmia Database: Moody & Mark (2001), IEEE Eng Med Biol; Goldberger et al. (2000), PhysioNet |
| Vorhofflimmer-Muster (nRMSSD, Wendepunkte, Shannon-Entropie) | Dash et al. (2009), Ann Biomed Eng |
| QTc | Fridericia (1920), Bazett (1920) zum Vergleich; Grenzwerte AHA/ACCF/HRS (2009) |

## Technik
- Reines HTML/CSS/JavaScript ohne Bibliotheken, kein Build-Schritt
- Polar Measurement Data (PMD) Service `FB005C80-…`: ECG 130 Hz, 14 bit, Werte in µV
- Heart Rate Service (`0x180D`) für HF und RR, Battery Service (`0x180F`)

| Datei | Inhalt |
|---|---|
| `index.html`, `css/style.css` | Oberfläche |
| `js/polar.js` | Bluetooth-Verbindung und Protokoll des H10 |
| `js/demo.js` | Simulierter Gurt |
| `js/ecgChart.js` | EKG-Darstellung (Live, Aufnahme, HF-Verlauf) |
| `js/filters.js` | Anzeige-Filter |
| `js/hrv.js` | Artefakterkennung und HRV-Werte |
| `js/analysis.js` | Automatische Auswertung (R-Zacken, Signalqualität, Schlagtypen, Rhythmus, EKG-Zeiten) |
| `js/hrvx.js` | Erweiterte HRV: Spektrum, Poincaré, Stress-Index, DFA |
| `js/charts2.js` | Spektrum, Poincaré, Verlaufskurven |
| `js/trends.js` | Kennwerte je Aufnahme und Verlaufsansicht |
| `js/storage.js` | Speicherung im Browser (IndexedDB) |
| `js/export.js` | CSV/TXT-Export und PDF-Bericht, Teilen-Menü auf iOS |
| `js/pdf.js` | Kleiner PDF-Erzeuger (Vektorgrafik, Helvetica) |
| `icon.svg`, `icon-180.png` | App-Symbol |
| `js/app.js` | Steuerung |
| `server.ps1`, `EKG starten.cmd` | Lokaler Webserver |
