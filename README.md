# Strom-Tagebuch

Private Web-App fürs iPhone: Stromverbrauch (Netzbezug, Einspeisung, Wärmepumpe, Wallbox, Laden unterwegs) erfassen und bis zur nächsten Jahresabrechnung hochrechnen.

## Auf dem iPhone installieren
1. In Safari öffnen: https://thomas-2026-dorf.github.io/strom-tagebuch/
2. Teilen-Symbol → **Zum Home-Bildschirm**
3. Ab dann wie eine normale App über das Symbol starten.

## Daten
- Alle Werte bleiben **nur auf dem iPhone** (Browser-Speicher). Im Repo stehen keine persönlichen Daten.
- Unter **Einstellungen → Sicherung exportieren** regelmäßig eine JSON-Datei sichern (z. B. in „Dateien" oder per AirDrop auf den Mac).
- Mit **Sicherung importieren** lässt sich eine Sicherung wieder einspielen.

## Aufbau
- `index.html`, `styles.css` – Oberfläche
- `js/app.js` – Bildschirme und Bedienung
- `js/calc.js` – Rechenkern (Tageswerte, Jahreszeit-Profile, Hochrechnung)
- `js/db.js` – Speicherung und Standard-Tarife
- `sw.js`, `manifest.webmanifest` – Offline-Betrieb und App-Symbol
