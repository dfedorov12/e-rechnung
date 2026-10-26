# Rechnungsmonitoring (Dashboard)

Der Reiter **`monitoring.html`** (`js/monitoring.js`) ist das werkübergreifende
Dashboard über alle Rechnungsbibliotheken einer eigenen SharePoint-Site
(`dihag.sharepoint.com/sites/Rechnungsmonitoring`). Es liest die Bibliotheken
**`ERAR_<Werk>`** (Eingang), **`AR_<Werk>`** (Ausgang) und optional die zentrale
`Rechnungseingang`-Stufe, aggregiert sie zu einer filterbaren Tabelle mit KPI-Kacheln.

Provisioniert werden die Bibliotheken/Spalten mit
[`scripts/provision-rechnungsmonitoring.ps1`](../scripts/provision-rechnungsmonitoring.ps1),
der Eingangs-Flow steht in [`Eingangsrechnungen-Flow.md`](Eingangsrechnungen-Flow.md).

---

## Zugriff

Welche Werke ein Benutzer sieht, steht in den **Einstellungen** (`einstellungen.html`, nur
Admins): Dort werden Werke angelegt und Benutzer (UPN) je Werk eingetragen. Die Zuweisung
gilt für Exportverlauf, Monitoring und die Werkauswahl im Konverter (`erlaubteWerke` in
`js/access.js`). Wer keinem Werk zugewiesen ist, sieht im Monitoring und im Konverter alle
Werke, Admins immer. Die zentrale `Rechnungseingang`-Stufe ist werkübergreifend sichtbar,
den tatsächlichen Zugriff regeln die SharePoint-Rechte.

## Laden

- **Nacheinander und seitenweise**: immer nur ein Abruf gegen SharePoint, die Tabelle
  füllt sich nach jeder Seite, Fortschritt im Untertitel. 429/503 werden wiederholt, eine
  Bibliothek mit Fehler hält die anderen nicht auf.
- **Neueste zuerst** (`$orderby=fields/Created desc`): Das Seitenlimit
  (`maxPagesPerLib`, 30 × 200 = 6000 Items/Bibliothek) liefert damit immer die aktuellsten
  Rechnungen. Jenseits von 5000 Items verlangt `$orderby` eine indizierte
  `Created`-Spalte (setzt das Provisioning), sonst lädt das Monitoring ungeordnet weiter.

## Zeilen-Aggregation

Eine Rechnung besteht oft aus mehreren Dateien (Original-PDF/-XML, extrahierte XML,
lesbares PDF, KoSIT-Bericht). Sie werden zu **einer Zeile** zusammengefasst (Gruppierung
über `baseKey` = Dateiname ohne Endung, Sidecar-Suffix und Datum). Die Dateien stehen als
kurze Abzeichen in der letzten Spalte: **PDF/XML** (Original), **Lesbar**, **Bericht**.

## Spalten

Welche Spalten ein Werk zeigt und in welcher Reihenfolge, legt ein Admin über den Knopf
**„Spalten“** fest (Einzelheiten in [Genehmigung-im-Monitoring.md](Genehmigung-im-Monitoring.md)).
Standard: vorn „Bearbeiten“ mit den Dateien (PDF, XML, Bericht), dann Datum, Werk, Richtung, Rechnungsnr., Steller / Empfänger, Netto, Fällig am,
Klassifizierung, Status, Buchung, Lieferant informiert, Konform., Fehler und, wo die
Bearbeitung an ist, Varialnummer, Bearbeitung, Genehmigung. Wählbar sind außerdem Brutto,
Bestellnummer, Kontierung und Notiz.

**Steller / Empfänger** zeigt nur, was sicher ist: den Namen aus der E-Rechnung (XML) oder
den Namen, den die Buchhaltung bei der 800k-Einschätzung bestätigt hat (kursiv). Den Namen,
den der Prüfdienst nur aus dem PDF-Text gelesen hat, zeigt die Tabelle nicht. Darunter steht
grün die Absenderadresse der Rechnungsmail, die der Eingangs-Flow mitschreibt.

**Buchung**: Bis 10/2026 blieb sie bei gelb und rot auf Automatik. Für solche Rechnungen
zeigt das Monitoring die heutige Regel (gelb = Unter Vorbehalt, rot = Zurückgewiesen), der
Tooltip nennt den gespeicherten Wert.

## Ansicht

- Die Tabelle scrollt in einem eigenen Bereich. **Kopfzeile und erste Spalte bleiben
  stehen**. Seitlich scrollen geht über die Leiste **oben** über der Tabelle und unten, beide
  laufen mit.
- **Zeile anklicken** (oder Enter) klappt alle Angaben zur Rechnung auf: Rechnung,
  Lieferant, Beträge, Prüfung mit vollem Hinweis, 800.000 €, Bearbeitung, Dateien, auch aus
  Spalten, die gerade ausgeblendet sind. **„Alle aufklappen“** gilt für die angezeigten
  Zeilen.
- **Kompakt / Groß**: Kompakt zeigt eine Rechnung möglichst auf einer Zeile (Hinweise
  einzeilig, Abzeichen nebeneinander), Groß hat viel Luft und größere Schrift. Der Browser
  merkt sich die Wahl.
- **Vollbild** legt Filter und Tabelle über den ganzen Bildschirm, Esc beendet es.
- Beim Scrollen lädt die Tabelle die nächsten 200 Zeilen von selbst nach, der Knopf
  „Weitere anzeigen“ bleibt als Rückfall. Ein Pfeil unten rechts springt zum Anfang.

## KPI-Kacheln

Rechnungen gesamt · Eingang · Ausgang · Offen (nicht gebucht) · **Fehler / rot** ·
**Dubletten** · Manuelle Prüfung · Zur Rückfrage · Zurückgewiesen · 800k-Einschätzung
offen · In Genehmigung (nur wenn ein Werk die Bearbeitung nutzt) · Typen. Die Kacheln
beziehen sich auf die gefilterte Auswahl, ein Klick filtert.

## Filter & Suche

Werk · Richtung · Typ · Konformität · Buchung (mit „Kleinbetrag bis 250 € brutto“) ·
Status · Bearbeitung · Genehmigt · Datum von/bis · Freitextsuche (Nummer, Steller,
Empfänger, Absendermail, Varialnummer, Kontierung, Bestellnummer, Notiz).

## Konformität + Klartext-Hinweis

Die Ampel kommt aus der KoSIT-Prüfung (`Konformitaet`). Ist eine Rechnung **nicht**
grün, zeigt das Dashboard unter der Pille einen **verständlichen Ein-Satz-Grund** statt
kryptischer BR-Codes (`_monHinweis`). Quelle ist die Spalte `ValidierungsMeldung`: steht
dort der fertige API-`hinweis`, wird er direkt gezeigt; steht dort der rohe
`meldungenText` (mit BR-/CII-Codes), leitet das Dashboard den Satz selbst ab (häufigste
Ursache zuerst, z. B. „Positionen ohne USt-Kategorie-Code (BT-151) …"). Spiegelt die
Logik von `_hinweisAusBefunden` in [`api/src/kosit.js`](../api/src/kosit.js).

## Dublettenerkennung

Rein clientseitig aus den geladenen Datensätzen (`_monMarkDupes`) — **kein Flow-Schritt,
keine Extra-Spalte**:

- **Echte Dublette** = gleiche **Rechnungsnummer beim selben Aussteller** im selben
  Werk/Richtung, verteilt auf mehrere Einträge → jede betroffene Zeile bekommt ein
  **⚠ Dublette**-Badge (Tooltip: „N× dieselbe Nummer von …") plus die KPI-Kachel
  **Dubletten**. Es wird nichts automatisch gelöscht oder überschrieben — der
  Sachbearbeiter entscheidet.
- **Gleiche Nummer, verschiedene Lieferanten** ist **keine** Dublette: der Aussteller ist
  Teil des Schlüssels → wird nicht markiert. (Eine Rechnungsnummer ist nur beim selben
  Aussteller eindeutig.)

**Grenze & Empfehlung:** Erkannt wird, was als **getrennte Einträge** abgelegt ist.
Benennt der Eingangs-Flow Dateien rein nach Nummer, können sich zwei Vorgänge mit
gleichem Namen beim Ablegen überschreiben (nur eine Zeile bliebe → nicht als Dublette
sichtbar). Deshalb liefert `/api/intake` den kollisionssicheren Dateinamen
**`dateibasis`** = `<Nummer>_<StellerVat>` (Aussteller-USt-IdNr., BT-31); als Dateiname
verwendet, bleiben verschiedene Lieferanten getrennt und echte Dubletten sichtbar.

> **Ausgang (AR) ist nicht betroffen:** dort ist der Aussteller immer das Werk selbst,
> die Nummern sind pro Werk eindeutig und der Dateiname trägt zusätzlich das Datum.

---

## Voraussetzungen

- Provisionierung der Bibliotheken/Spalten inkl. **indizierter `Created`-Spalte**
  (`scripts/provision-rechnungsmonitoring.ps1`).
- Die Metadaten-Spalten füllt der Konverter (Ausgang, `js/sharepoint.js`) bzw. der
  Power-Automate-Eingangs-Flow (`/api/intake`). Ohne befüllte Spalten (z. B.
  `Rechnungssteller`) kann eine Zeile nicht als Dublette bewertet werden.
