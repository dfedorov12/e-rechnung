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
Werke, Admins immer. Beim Öffnen ist das zugewiesene Werk im Filter vorgewählt (bei mehreren
das erste), „Alle Werke“ bleibt wählbar. Die zentrale `Rechnungseingang`-Stufe ist werkübergreifend sichtbar,
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

**Rechnungsnummer:** Sie steht im `Title`. Bei XML-Dateien setzt SharePoint den `Title`
selbst auf den Dateinamen (`20261967_DE811979246.xml`), auch wenn der Flow die Nummer
schreibt. Ein solcher Title zählt nicht. Dann gilt der Title einer anderen Datei der
Rechnung (Original-PDF, lesbares PDF), sonst wird die Nummer aus dem Dateinamen abgeleitet:
die USt-IdNr. bzw. das Lieferantenkürzel aus `dateibasis` und ein Zeitstempel einer zweiten
Datei (`_JJJJMMTThhmmss`) fallen weg. Eine Korrektur unter „Bearbeiten“ geht vor.

**Erstellt am** ist der Zeitpunkt, zu dem die erste Datei der Rechnung in SharePoint
angelegt wurde. Die Tabelle ist danach sortiert, die neuesten Vorgänge stehen oben.

## Spalten

Welche Spalten ein Werk zeigt und in welcher Reihenfolge, legt ein Admin über den Knopf
**„Spalten“** fest (Einzelheiten in [Genehmigung-im-Monitoring.md](Genehmigung-im-Monitoring.md)).
Standard: vorn „Bearbeiten“ mit den Dateien (PDF, XML, Bericht), dann Datum, Erstellt am, Werk, Richtung, Rechnungsnr., Steller / Empfänger, Netto, Fällig am,
Klassifizierung, Status, Buchung, Lieferant informiert, Konform., Fehler und, wo die
Bearbeitung an ist, Varialnummer, Bearbeitung, Genehmigung. Wählbar sind außerdem Brutto,
Bestellnummer, Kontierung und Notiz. Werke mit eigener Spaltenauswahl bekommen „Erstellt am“
erst, wenn der Admin die Spalte dort anhakt. Sortiert wird trotzdem danach.

**Steller / Empfänger** zeigt nur, was sicher ist, in dieser Reihenfolge:

1. der Name, den die Kreditorenbuchhaltung an dieser Rechnung bestätigt hat (unter
   „Bearbeiten“ oder bei der 800k-Einschätzung), mit grünem ✓,
2. der Name aus der E-Rechnung (XML),
3. der Name aus dem Lieferantenregister, erkannt über die USt-IdNr. oder eine schon
   bestätigte Schreibweise (kursiv, an dieser Rechnung noch nicht bestätigt).

Den Namen, den der Prüfdienst nur aus dem PDF-Text gelesen hat, zeigt die Tabelle nicht,
die aufgeklappte Zeile nennt ihn als „nicht bestätigt“. Darunter steht grün die
Absenderadresse der Rechnungsmail, die der Eingangs-Flow mitschreibt.

## Rechnungsnummer und Lieferant korrigieren

Liest der Prüfdienst Nummer oder Lieferant falsch aus dem PDF-Text, korrigiert die
Buchhaltung beides oben im Dialog **„Bearbeiten“**. Gespeichert wird an der Datei, an der
die Bearbeitung hängt (Original-PDF, bei XRechnung das lesbare PDF): `Title` und
`Rechnungssteller`. Der Versionsverlauf der Datei hält fest, wer was geändert hat.

Ein geänderter Lieferant wird **bestätigt und gemerkt**. Stimmt ein gelesener Name, reicht
der Haken „Lieferant bestätigen und für weitere Rechnungen merken“. Nach der Korrektur fasst
das Monitoring die Zeilen neu zusammen und prüft die Dubletten neu.

## Lieferantenregister

`Monitoring/lieferanten-umsatzgrenze.json` auf der Monitoring-Site war das Register der
800k-Einschätzungen und ist jetzt das Lieferantenregister. Je Lieferant steht dort:

| Feld | Inhalt |
|------|--------|
| `name`, `vat`, `mail` | Name, USt-IdNr., Mailadresse für Kreditor-Mails |
| `aliase` | Schreibweisen aus dem PDF-Text, die schon einmal zu diesem Lieferanten bestätigt wurden (höchstens 10) |
| `bestaetigtAm`, `bestaetigtVon`, `bestaetigtVonName` | letzte Bestätigung durch die Kreditorenbuchhaltung |
| `vermutung`, `am`, `vonName`, `verlauf` | 800k-Einschätzung, falls es eine gibt |

`rechnungen` ordnet einzelne Rechnungen (Dateischlüssel) einem Lieferanten zu. Bestätigt
wird bei der 800k-Einschätzung und unter „Bearbeiten“. Eine neue Rechnung wird erkannt über
die Zuordnung, die USt-IdNr., den Namen oder eine gemerkte Schreibweise. Name und
Schreibweise zählen nicht, wenn beide USt-IdNr. bekannt sind und sich unterscheiden.
Schreibrechte braucht die Kreditorenbuchhaltung auf diese Datei („Mitwirken“).

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
- **Spaltenbreite** per Ziehen am rechten Rand einer Kopfzelle, Doppelklick setzt die Spalte
  zurück, „Breiten zurücksetzen“ alle. Eigene Breiten merkt sich der Browser je Werk. Der
  Admin kann seine Breiten im Dialog „Spalten“ als Standard für alle speichern, eigene
  Breiten gehen vor.
- Ein Pfeil im Kopf zeigt die Sortierung. Ohne Klick ist es **Erstellt am**, neueste zuerst.
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

Vor „Datum von/bis“ steht, welches Datum gilt: **Rechnungsdatum** (Standard) oder
**Erstellt am**. Gefiltert wird nach dem Kalendertag in Deutschland.

## Konformität + Klartext-Hinweis

Die Ampel kommt aus der KoSIT-Prüfung (`Konformitaet`). Ist eine Rechnung **nicht**
grün, zeigt das Dashboard unter der Pille einen **verständlichen Ein-Satz-Grund** statt
kryptischer BR-Codes (`_monHinweis`). Quelle ist die Spalte `ValidierungsMeldung`: steht
dort der fertige API-`hinweis`, wird er direkt gezeigt; steht dort der rohe
`meldungenText` (mit BR-/CII-Codes), leitet das Dashboard den Satz selbst ab (häufigste
Ursache zuerst, z. B. „Positionen ohne USt-Kategorie-Code (BT-151) …"). Spiegelt die
Logik von `_hinweisAusBefunden` in [`api/src/kosit.js`](../api/src/kosit.js).

## Dublettenerkennung

Im Monitoring aus den geladenen Datensätzen (`_monMarkDupes`), ohne Extra-Spalte:

- **Dublette** = gleiche **Rechnungsnummer beim selben Lieferanten** im selben
  Werk und in derselben Richtung, verteilt auf mehrere Einträge. Jede betroffene Zeile
  bekommt das Abzeichen **⚠ Dublette**, dazu die KPI-Kachel **Dubletten**. Gelöscht oder
  überschrieben wird nichts, die Buchhaltung entscheidet.
- **Derselbe Lieferant** heißt: gleiche USt-IdNr., sonst derselbe Eintrag im
  Lieferantenregister oder derselbe Name. Zwei verschiedene USt-IdNr. sind immer
  verschiedene Lieferanten.
- **Gleiche Nummer, verschiedene Lieferanten** ist **keine** Dublette.
- **Inhalt:** Nach dem Laden holt das Monitoring für die Dubletten die Prüfsumme der
  Originaldateien, die SharePoint ohnehin je Datei führt (`quickXorHash`). Das Abzeichen
  sagt dann **gleiche Datei** (dieselbe Rechnung ist mehrfach eingegangen) oder **anderer
  Inhalt** (bitte prüfen: Kopie, Korrektur oder neue Rechnung). Ohne Prüfsumme bleibt es
  bei „mögliche Doppelerfassung“.

**Nicht überschreiben:** Erkannt wird nur, was als **getrennte Dateien** abgelegt ist.
`/api/intake` liefert den Dateinamen **`dateibasis`** = `<Nummer>_<StellerVat>`, damit
kollidieren verschiedene Lieferanten nicht. Kommt dieselbe Rechnung ein zweites Mal, hätte
die neue Datei denselben Namen. „Datei erstellen“ in Power Automate ersetzt dann die alte
(sie wird nur eine neue Version). Der Eingangs-Flow prüft deshalb vorher, ob der Name schon
belegt ist, und hängt dann einen Zeitstempel an (`<dateibasis>_JJJJMMTThhmmss`), siehe
[Eingangsrechnungen-Flow.md](Eingangsrechnungen-Flow.md), Schritt b.

> **Ausgang (AR) ist nicht betroffen:** dort ist der Aussteller immer das Werk selbst,
> die Nummern sind pro Werk eindeutig und der Dateiname trägt zusätzlich das Datum.

---

## Voraussetzungen

- Provisionierung der Bibliotheken/Spalten inkl. **indizierter `Created`-Spalte**
  (`scripts/provision-rechnungsmonitoring.ps1`).
- Die Metadaten-Spalten füllt der Konverter (Ausgang, `js/sharepoint.js`) bzw. der
  Power-Automate-Eingangs-Flow (`/api/intake`). Ohne Rechnungsnummer und ohne Lieferant
  (USt-IdNr., Register oder Name) kann eine Zeile nicht als Dublette bewertet werden.
