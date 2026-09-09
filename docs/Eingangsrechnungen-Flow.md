# Eingangsrechnungen – zentrale Prüfstufe, dann in die Werk-Listen

Ziel (deine Vorgabe): **alle** eingehenden Rechnungen landen zuerst zentral im
Monitoring, werden dort **geprüft und klassifiziert** (ZUGFeRD / XRechnung-XML /
normales PDF), die XML und das lesbare PDF werden abgelegt – und **erst dann**
sortiert der Flow die Rechnung in die Eingangsrechnungsliste des Werks (`ERAR_<Werk>`).

```
Lieferant (E-Mail / Upload / ERP-Export)
        │
        ▼
 [ Rechnungseingang ]  ← EINE zentrale Bibliothek (werkübergreifend)
        │  Power Automate: "Wenn eine Datei erstellt wird"
        │  POST /api/intake                (ein Aufruf, ein JSON zurück)
        │     • klassifiziert: zugferd | xrechnung-xml | pdf-ohne-xml
        │     • validiert:     KoSIT (+ vollständiger Bericht) + veraPDF
        │     • erkennt Werk:  aus dem RechnungsEMPFÄNGER (Käufer = WGC/SHB)
        │     • liefert:       Kopfdaten, XML, lesbares PDF/A (base64), KoSIT-Bericht
        ▼
 Spalten setzen + Sidecars ablegen (XML, lesbares PDF, KoSIT-Bericht)
        │
        ▼
 → ERAR_<Werk>   (Original + Sidecars); Eingangskorb-Kopie wird entfernt
```

Warum zentral zuerst: das Werk steht erst **nach** dem Parsen fest (der Käufer wird
aus der Rechnung gelesen), und die Prüfung soll einheitlich passieren, bevor etwas
in die Werk-Listen wandert.

---

## Voraussetzungen (einmalig)

1. **Provisionierung** inkl. Eingangsstufe (legt `Rechnungseingang` + die neuen
   Spalten `Klassifizierung`, `LesbarPdfUrl`, `KoSITBerichtUrl` an):
   ```powershell
   .\provision-rechnungsmonitoring.ps1 `
       -SiteUrl https://dihag.sharepoint.com/sites/Rechnungsmonitoring `
       -ClientId df9691fc-bed8-4134-820e-99654640eb0e
   ```
   (Bestehende Bibliotheken/Spalten werden übersprungen, nur Fehlendes kommt dazu.)

2. **API neu deployen**, damit `/api/intake` live ist:
   ```bash
   cd api
   npm run sync
   func azure functionapp publish erechnung-xml2pdf
   ```
   App-Einstellungen `KOSIT_DAEMON_URL` und `VERAPDF_URL` sind bereits gesetzt.

3. **Funktions-Key** für `/api/intake` (Portal → Function App → App keys). Der Key ist
   ein Geheimnis; im Flow nur als `?code=<KEY>` in der URL, nicht im Klartext teilen.

---

## `/api/intake` – Vertrag

`POST /api/intake?code=<KEY>` · Body = die rohe Datei (ZUGFeRD-PDF, XRechnung-XML
oder normales PDF). Antwort = JSON:

| Feld | Bedeutung |
|------|-----------|
| `klassifizierung` | `zugferd` \| `xrechnung-xml` \| `pdf-ohne-xml` |
| `werk` | `WGC` \| `SHB` \| `''` (aus dem Empfänger erkannt; leer = unklar) |
| `konform` / `konformLabel` | KoSIT-Urteil `gruen`/`gelb`/`rot` bzw. `Ungeprueft` |
| `accepted`, `errorCount`, `warningCount`, `meldungen[]` | KoSIT-Details |
| `bericht` | **vollständiger KoSIT-Prüfbericht** (String) → archivieren |
| `pdfa` | veraPDF-Ergebnis der PDF/A-Hülle (nur bei PDF-Eingang) |
| `daten` | `nummer, datum, faelligkeit, steller, empfaenger, netto, mwst, brutto, waehrung, leitwegid, bestellnummer, lieferscheinnummer, …` |
| `xml` | extrahierte (ZUGFeRD) bzw. empfangene E-Rechnungs-XML; `null` bei `pdf-ohne-xml` |
| `lesbarPdfBase64` | **nur bei `xrechnung-xml`**: das aus der XML gerenderte, lesbare PDF/A (base64). Bei ZUGFeRD ist das Original-PDF bereits lesbar. |

Schneller Test (PowerShell):
```powershell
curl.exe -s -X POST "https://erechnung-xml2pdf.azurewebsites.net/api/intake?code=<KEY>" `
  --data-binary "@C:\pfad\zur\rechnung.pdf" | ConvertFrom-Json | Format-List klassifizierung,werk,konform
```

---

## Power-Automate-Flow „Eingang prüfen und einsortieren"

**Trigger:** *Wenn eine Datei erstellt wird* (SharePoint), Bibliothek
`Rechnungseingang`.

1. **Dateiinhalt abrufen** – *Dateiinhalt abrufen* (Identifier =
   `triggerBody()?['{Identifier}']`).

2. **HTTP – POST an `/api/intake`**
   - Methode `POST`, URI `https://erechnung-xml2pdf.azurewebsites.net/api/intake?code=<KEY>`
   - Header `Content-Type: application/octet-stream`
   - Body = **Dateiinhalt** aus Schritt 1
   - **Kein** „Chunked"/`transferMode` setzen (Azure Functions unterstützt das nicht →
     sonst 400 wegen leerem Aushandlungs-Body – das war der Fehler beim Validate-Flow).

3. **Variablen** (Compose) zur besseren Lesbarkeit:
   - `werk`   = `body('HTTP')?['werk']`
   - `nr`     = `coalesce(body('HTTP')?['daten']?['nummer'], triggerBody()?['{FilenameWithExtension}'])`
   - `zielLib` = `concat('ERAR_', body('HTTP')?['werk'])`

4. **Verzweigung „Werk erkannt?"** – Bedingung `werk` **ist nicht** leer.

   **➜ Nein (Werk unklar):** Nur Spalten am Eingangskorb-Element setzen
   (`Klassifizierung`, `Konformitaet`, `Verarbeitungsstatus = Fehler`,
   `Fehlermeldung = "Werk aus Empfänger nicht erkannt – bitte manuell zuordnen"`).
   Datei **bleibt** in `Rechnungseingang`. Flow endet.

   **➜ Ja:** weiter mit dem Einsortieren.

5. **Original in `ERAR_<Werk>` anlegen** – *Datei erstellen*
   - Websiteadresse: die Monitoring-Site
   - Ordnerpfad: `outputs('zielLib')`  (dynamisch, z. B. `ERAR_SHB`)
   - Dateiname: `triggerBody()?['{FilenameWithExtension}']`
   - Dateiinhalt: Schritt 1
   - → merkt sich die neue **ItemId** für Schritt 8.

6. **Sidecars ablegen** (in dieselbe `zielLib`, nur wenn vorhanden):
   - **XML:** wenn `body('HTTP')?['xml']` nicht leer → *Datei erstellen*
     `@{outputs('nr')}.xml`, Inhalt = `body('HTTP')?['xml']`.
   - **Lesbares PDF:** wenn `body('HTTP')?['lesbarPdfBase64']` nicht leer →
     *Datei erstellen* `@{outputs('nr')}_lesbar.pdf`,
     Inhalt = `base64ToBinary(body('HTTP')?['lesbarPdfBase64'])`.
   - **KoSIT-Bericht:** wenn `body('HTTP')?['bericht']` nicht leer → *Datei erstellen*
     `@{outputs('nr')}_KoSIT-Bericht.xml`, Inhalt = `body('HTTP')?['bericht']`.

7. **PDF/A-Status ableiten** (Compose) aus `body('HTTP')?['pdfa']`:
   - `pdfa.konform == 'ok'` → `PDF/A-3b ok`
   - `pdfa.konform == 'fehler'` → `PDF/A Fehler`
   - `klassifizierung == 'xrechnung-xml'` → `n/a (nur XML)`
   - sonst → `Ungeprueft`

8. **Dateieigenschaften aktualisieren** – am in Schritt 5 erstellten Element:
   | Spalte | Wert |
   |--------|------|
   | `Title` (Rechnungsnummer) | `body('HTTP')?['daten']?['nummer']` |
   | `Klassifizierung` | Mapping aus `klassifizierung` (`zugferd`→ZUGFeRD (PDF+XML), `xrechnung-xml`→XRechnung (XML), `pdf-ohne-xml`→PDF ohne E-Rechnung) |
   | `Format` | `zugferd`→ZUGFeRD, `xrechnung-xml`→XRechnung, `pdf-ohne-xml`→PDF |
   | `Richtung` | `Eingang` |
   | `Gesellschaft` | `body('HTTP')?['werk']` |
   | `Rechnungssteller` | `daten.steller` |
   | `Rechnungsempfaenger` | `daten.empfaenger` |
   | `Rechnungsdatum` / `Faelligkeitsdatum` | `daten.datum` / `daten.faelligkeit` |
   | `Nettobetrag`/`MwStBetrag`/`Bruttobetrag`/`Waehrung` | aus `daten` |
   | `Bestellnummer`/`Lieferscheinnummer`/`Kaeuferreferenz` | `daten.bestellnummer` / `daten.lieferscheinnummer` / `daten.leitwegid` |
   | `Konformitaet` | `body('HTTP')?['konformLabel']` |
   | `ValidierungsMeldung` | `join(body('HTTP')?['meldungen'], '; ')` (oder leer) |
   | `PDFAStatus` | Compose aus Schritt 7 |
   | `KoSITBerichtUrl` / `LesbarPdfUrl` | WebUrl der in Schritt 6 erstellten Dateien |
   | `Verarbeitungsstatus` | `if(equals(body('HTTP')?['konform'],'rot'),'Fehler','Validiert')` |

9. **Eingangskorb aufräumen** – *Datei löschen* (das Trigger-Element in
   `Rechnungseingang`), damit dort nur noch **unklare/fehlerhafte** Rechnungen liegen.
   (Wer eine dauerhafte Eingangskopie will, lässt diesen Schritt weg – dann zeigt das
   Dashboard die Rechnung einmal im Eingangskorb und einmal im Werk.)

---

## Behandlung der drei Fälle

| Eingang | XML | Lesbares PDF | KoSIT | veraPDF | Ablage |
|--------|-----|--------------|-------|---------|--------|
| **ZUGFeRD-PDF** | aus PDF extrahiert (Sidecar) | Original-PDF ist bereits lesbar | ja (+ Bericht) | ja (PDF/A-3b) | `ERAR_<Werk>` |
| **XRechnung-XML** | die empfangene XML | gerendert aus XML (`lesbarPdfBase64`) | ja (+ Bericht) | – | `ERAR_<Werk>` |
| **Normales PDF (kein E-Invoice)** | – | Original-PDF | – (`Ungeprueft`) | ja (nur PDF/A-Info) | `ERAR_<Werk>`, `Klassifizierung = PDF ohne E-Rechnung` |

**Normales PDF:** wird geprüft-erkannt, gekennzeichnet und archiviert, aber **nicht
automatisch in eine XRechnung umgewandelt** – eine zuverlässige Auto-Konvertierung
beliebiger Lieferanten-Layouts ist nicht seriös leistbar. Bei Bedarf wandelt man ein
solches PDF manuell in der E-Rechnung-App um. (Falls doch eine automatische
OCR-Konvertierung gewünscht ist, ist das ein eigener, größerer Ausbau.)

---

## Was landet wo (Zusammenfassung)

- **`Rechnungseingang`**: Rohzugang; nach dem Flow nur noch unklare/fehlerhafte Fälle.
- **`ERAR_<Werk>`**: geprüfte Eingangsrechnung mit Original, XML, lesbarem PDF und
  KoSIT-Bericht + gesetzten Metadaten.
- **Monitoring-Dashboard**: zeigt Eingangskorb **und** die Werk-Listen (der Eingang
  erscheint als Werk „(Eingang)", bis er einsortiert ist).
