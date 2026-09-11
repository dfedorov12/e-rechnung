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

Der Aufruf übergibt eine **Freigabeliste** (`accessList`, Werk-Kürzel des Nutzers aus
`AppPermissions`). Sichtbar sind nur die Werk-Bibliotheken, für die der Nutzer
freigeschaltet ist; die zentrale `Rechnungseingang`-Stufe ist werkübergreifend (die
SharePoint-Rechte gaten den tatsächlichen Zugriff). Ohne Freigabe → Hinweisseite.

## Laden (Skalierung)

- **Parallel** über alle Bibliotheken (statt sequenziell) → schnelles Laden auch bei
  vielen Werken.
- **Neueste zuerst** (`$orderby=fields/Created desc`): das Seitenlimit
  (`maxPagesPerLib`, 30 × 200 = 6000 Items/Bibliothek) liefert damit immer die
  **aktuellsten** Rechnungen, statt in der Graph-Default-Reihenfolge (ID aufsteigend =
  älteste zuerst) die neuen abzuschneiden.
- Jenseits von **5000 Items/Bibliothek** verlangt `$orderby` eine **indizierte
  `Created`-Spalte** (setzt das Provisioning). Ist sie (noch) nicht indiziert, lädt das
  Dashboard automatisch ungeordnet weiter (graceful Fallback) — es bricht nie ab.

## Zeilen-Aggregation

Eine Rechnung besteht oft aus mehreren Dateien (Original-PDF/-XML, extrahierte XML,
lesbares PDF, KoSIT-Bericht). Sie werden zu **einer Zeile** zusammengefasst
(Gruppierung über `baseKey` = Dateiname ohne Endung/Sidecar-Suffix/Datum). Die
Nebendateien erscheinen als Links in der letzten Spalte:

- **Original (XML/PDF) ↗** — die primäre Datei
- **Lesbares PDF ↗** — aus XRechnung-XML gerendertes PDF/A (bei ZUGFeRD ist das
  Original schon lesbar)
- **KoSIT-Bericht ↗** — vollständiger Prüfbericht

## Spalten

| Spalte | Inhalt |
|--------|--------|
| Datum | Rechnungs- bzw. Eingangsdatum |
| Werk | aus dem Bibliotheksnamen (`AR_SHB` → SHB); Eingangsstufe: erst nach Erkennung |
| Richtung | Eingang / Ausgang |
| Rechnungsnr. | Nummer; darunter ggf. Badge **⚠ Dublette** (siehe unten) |
| Steller / Empfänger | Aussteller (Eingang) bzw. Empfänger (Ausgang) |
| Brutto | Bruttobetrag |
| Format | ZUGFeRD / XRechnung / PDF |
| Status | Verarbeitungsstatus |
| Konform. | KoSIT-Ampel (grün/gelb/rot) + **Klartext-Hinweis** darunter (siehe unten) |
| Fehler | Fehlermeldung (z. B. Fehlleitung, Fehler-Benachrichtigung) |
| (Links) | Original + Sidecar-Dateien |

## KPI-Kacheln

Rechnungen gesamt · Eingang · Ausgang · Offen (nicht gebucht) · **Fehler / rot** ·
**Dubletten** · Bruttosumme. Die Kacheln beziehen sich auf die **aktuell gefilterte**
Auswahl.

## Filter & Suche

Werk · Richtung · Status · Format · Freitextsuche (Nummer, Steller, Empfänger).

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
