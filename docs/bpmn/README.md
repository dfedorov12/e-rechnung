# Prozessmodelle (BPMN 2.0)

Die Prozesse der E-Rechnung als BPMN 2.0 im Hausschema des RMS: drei Hauptprozesse und
sechs Unterprozesse, die per Aufrufaktivität (⊞) eingebunden sind.

**Führend sind die Modelle im RMS** (rms.dihag.de, Reiter Prozesse, Ablage KONZERN).
`prozess.html` liest sie live von dort, sobald das angemeldete Konto Zugriff auf die
ISMS-Bibliothek hat. Wer im RMS ein Modell ändert, ändert es damit auch auf der
E-Rechnungs-Seite, und weil die Unterprozesse eingebunden statt kopiert sind, auch in
jedem Hauptprozess, der sie nutzt. Ohne Zugriff zeigt die Seite die Kopie aus diesem
Ordner und sagt das dazu. „im RMS öffnen“ führt über `?modell=<Kennung>` direkt in die
Ansicht des Modells.

| Datei | Modell im RMS | Bindet ein |
|-------|---------------|------------|
| `01-rechnungseingang.bpmn` | E-Rechnung Rechnungseingang | Eingangsprüfung, Nebendateien ablegen |
| `01a-eingangspruefung.bpmn` | E-Rechnung Eingangsprüfung | |
| `01b-nebendateien.bpmn` | E-Rechnung Nebendateien ablegen | |
| `02-rechnungsausgang.bpmn` | E-Rechnung Rechnungsausgang | Erkennen und erfassen, Prüfen und erzeugen |
| `02a-erkennen-und-erfassen.bpmn` | E-Rechnung Erkennen und erfassen | |
| `02b-pruefen-und-erzeugen.bpmn` | E-Rechnung Prüfen und erzeugen | |
| `03-zahlungsausgang-mc-converter.bpmn` | Zahlungsausgang (MC-Converter) | Zahldatei umstellen, Preflight |
| `03a-umstellen.bpmn` | Zahldatei auf pain.001.001.09 umstellen | |
| `03b-preflight.bpmn` | Zahldatei-Preflight | |

`modelle.json` ist die Liste, aus der `prozess.html` liest: Datei, Prozess-Kennung,
Datei-Kennung im RMS (`itemId`) und die Bibliothek (`driveId`). `rms-ids.json` hält die
Kennungen nach dem Import fest.

## Hausschema

Alle neun Modelle bestehen die Prüfung des RMS (`prozessSchemaPruefen`) ohne Befund:
ein Auslöser, benannte Ergebnisse, nur 👤 Mensch, ⚙ Automatik oder ✋ Handgriff, jeder
Knoten in einer Bahn, beschriftete Entscheidungen, nichts hängt lose, Aufgaben enden auf
einem Verb, Unterprozesse als ⊞ mit Marker `[[rms:modell=<Kennung>]]`. Externe Partner
(Lieferant, Kunde, Bank) sind geschlossene Pools. Offen bleibt R9: Eine Richtlinie wird im
RMS am Modell verknüpft.

## Farben

| Farbe | Beteiligter |
|-------|-------------|
| Blau | Werks-Postfach und Power Automate |
| Violett | Prüfdienst (Azure) |
| Türkis | SharePoint und Monitoring |
| Orange | Menschen: Buchhaltung, Vertrieb, Treasury |
| Dunkelblau | Browser-Apps (Konverter, MC-Converter) |
| Grau | ERP, MultiCash, Versand; hell: extern (Lieferant, Kunde, Bank) |

Ergebnisfarben: grün = Start und gutes Ende, gelb = Entscheidung, hellgelb = Vorbehalt oder
Prüfung, rot = Fehler oder Zurückweisung, hellgrau = geplant oder außerhalb dieses Tools.

## Ändern

Im Alltag im RMS: Modell öffnen, bearbeiten, speichern. Die E-Rechnungs-Seite zeigt den
neuen Stand beim nächsten Laden.

Für größere Umbauten gibt es den Generator `scripts/bpmn/generate-bpmn.js` (Knoten im
Raster, Flüsse, Notizen). Er schreibt die neun Dateien und `modelle.json` neu und setzt die
Marker aus `rms-ids.json`:

```bash
node scripts/bpmn/generate-bpmn.js
```

Danach müssen die Dateien wieder ins RMS (gleicher Name in Prozesse/KONZERN ergibt eine neue
Version derselben Datei, die Kennungen bleiben). Vorsicht: Das überschreibt Änderungen, die
seit dem letzten Import im RMS gemacht wurden.
