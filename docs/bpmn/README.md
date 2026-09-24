# Prozessmodelle (BPMN 2.0)

Die Prozesse der E-Rechnung als BPMN 2.0 mit Layout, Farben und allen Unterprozessen.
Sichtbar auf `prozess.html` (Viewer mit Zoom, Unterprozess-Ansicht, Download als BPMN und SVG).

| Datei | Inhalt | Unterprozesse |
|-------|--------|---------------|
| `01-rechnungseingang.bpmn` | Lieferant, Werks-Postfach und Power Automate, Prüfdienst `/api/intake`, SharePoint `ERAR_<Werk>`, Kreditorenbuchhaltung | Eingangsprüfung, Nebendateien ablegen |
| `02-rechnungsausgang.bpmn` | Versand, Vertrieb, Konverter, SharePoint `AR_<Werk>`, Kunde | Erkennen und erfassen, Prüfen und E-Rechnung erzeugen |
| `03-zahlungsausgang-mc-converter.bpmn` | ERP / MultiCash, MC-Converter, Treasury, Hausbank | Umstellen auf pain.001.001.09, SEPA-Preflight |

Öffnen im Camunda Modeler, auf bpmn.io oder in Signavio. Unterprozesse sind zugeklappt
und lassen sich per Pfeil am Symbol aufklappen.

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

Die Dateien werden erzeugt, nicht von Hand gepflegt. Quelle ist
`scripts/bpmn/generate-bpmn.js` (Knoten im Raster, Flüsse, Notizen, Unterprozesse).
Nach einer Änderung neu erzeugen:

```bash
node scripts/bpmn/generate-bpmn.js
```

Wer ein Diagramm lieber im Camunda Modeler weiterbearbeitet, kann das tun. Dann gilt die
bearbeitete Datei als neue Quelle und der Generator sollte für diese Datei nicht mehr laufen.
