# Eingangsrechnungen – geprüft in die Werk-Listen

Eingehende Rechnungen kommen **pro Werk über eine eigene E-Mail-Adresse** rein
(z. B. `rechnung-wgc@…`, `rechnung-shb@…`). Damit ist die **Trennung nach Werk schon
gegeben** – das Werk steht beim Eingang fest, es muss nicht erst aus der Rechnung
erraten werden. Jede Rechnung wird beim Eingang **geprüft und klassifiziert** und
landet direkt in der Eingangsliste ihres Werks `ERAR_<Werk>`.

```
E-Mail an rechnung-WGC@…  ─┐
E-Mail an rechnung-SHB@…  ─┤   Werk ist HIER schon bekannt (Postfach / Adresse)
                           ▼
   Power Automate ruft  POST /api/intake?werk=<Werk>
        • klassifiziert: zugferd | xrechnung-xml | pdf-ohne-xml
        • validiert:     KoSIT (+ vollständiger Bericht) + veraPDF
        • Gegenprobe:    Werk aus dem Empfänger (werkMismatch = mögliche Fehlleitung)
        • liefert:       Kopfdaten, XML, lesbares PDF/A (base64), KoSIT-Bericht
                           ▼
   direkt in ERAR_<Werk>  — Original + XML + lesbares PDF + KoSIT-Bericht + Spalten
```

Die Käufer-Erkennung (`src/werk.js`) ist damit **nicht** mehr der Router, sondern nur
noch die **Absicherung**: Passt der Rechnungsempfänger nicht zum Postfach-Werk, meldet
die API `werkMismatch = true` → im Flow als Prüf-Hinweis kennzeichnen.

> **Zentrale `Rechnungseingang`-Bibliothek ist damit optional** – nur noch als
> Auffangkorb sinnvoll (z. B. eine allgemeine Rechnungs-Adresse, die keinem Werk
> zugeordnet ist). Wer sie nicht braucht: Provisioning mit `-OhneEingangsstufe`.

---

## Voraussetzungen (einmalig)

1. **Provisionierung** (legt die neuen Spalten `Klassifizierung`, `LesbarPdfUrl`,
   `KoSITBerichtUrl` an, **indiziert `Created`** — nötig fürs Neueste-zuerst-Laden im
   Monitoring jenseits von 5.000 Items/Bibliothek; `Rechnungseingang` nur, wenn gewünscht):
   ```powershell
   .\provision-rechnungsmonitoring.ps1 `
       -SiteUrl https://dihag.sharepoint.com/sites/Rechnungsmonitoring `
       -ClientId df9691fc-bed8-4134-820e-99654640eb0e
   # ohne den zentralen Auffangkorb:  ... -OhneEingangsstufe
   ```

2. **API neu deployen**, damit `/api/intake` live ist:
   ```bash
   cd api && npm run sync && func azure functionapp publish erechnung-xml2pdf
   ```
   App-Einstellungen `KOSIT_DAEMON_URL` und `VERAPDF_URL` sind bereits gesetzt.

3. **Funktions-Key** für `/api/intake` (Portal → Function App → App keys). Nur als
   `?code=<KEY>` in der Flow-URL, nicht im Klartext teilen.

---

## `/api/intake` – Vertrag

`POST /api/intake?code=<KEY>&werk=<Werk>` · Body = die rohe Datei (ZUGFeRD-PDF,
XRechnung-XML oder normales PDF). `werk` = das Kürzel aus dem Postfach (optional;
fehlt es, wird das Werk aus dem Empfänger abgeleitet). Antwort = JSON:

| Feld | Bedeutung |
|------|-----------|
| `klassifizierung` | `zugferd` \| `xrechnung-xml` \| `pdf-ohne-xml` |
| `werk` | das maßgebliche Werk (Postfach-Hinweis `?werk=`, sonst erkannt) |
| `werkErkannt` | aus dem Rechnungs**empfänger** abgeleitet (Gegenprobe) |
| `werkMismatch` | `true`, wenn `?werk=` ≠ `werkErkannt` → mögliche Fehlleitung |
| `konform` / `konformLabel` | KoSIT-Urteil `gruen`/`gelb`/`rot` bzw. `Ungeprueft` |
| `accepted`, `errorCount`, `warningCount`, `meldungen[]` | KoSIT-Details |
| `meldungenText` | alle KoSIT-Befunde als **fertiger Text** (kein Array-Join im Flow nötig) |
| `hinweis` | **Ein-Satz-Klartext**, *warum* nicht konform (häufigste Ursache zuerst) → in `ValidierungsMeldung` schreiben |
| `profilFallback` | gesetzt, wenn gegen **EN16931** statt XRechnung geprüft (Factur-X/ZUGFeRD BASIC/EXTENDED) |
| `bericht` | **vollständiger KoSIT-Prüfbericht** (String) → archivieren |
| `pdfa` | veraPDF-Ergebnis der PDF/A-Hülle (nur bei PDF-Eingang) |
| `daten` | `nummer, datum, faelligkeit, steller, stellerVat, empfaenger, netto, mwst, brutto, waehrung, leitwegid, bestellnummer, lieferscheinnummer, …` |
| `dateibasis` | **dublettensicherer Dateiname‑Baustein** `<Nummer>_<StellerVat>` (bereinigt). Als Dateiname verwenden → gleiche Nummer verschiedener Lieferanten kollidiert nicht; existiert die Datei schon = echte Dublette. |
| `xml` | extrahierte (ZUGFeRD) bzw. empfangene E-Rechnungs-XML; `null` bei `pdf-ohne-xml` |
| `lesbarPdfBase64` | **nur bei `xrechnung-xml`**: das aus der XML gerenderte, lesbare PDF/A (base64). Bei ZUGFeRD ist das Original-PDF bereits lesbar. |

> **Factur-X/ZUGFeRD-Profil-Fallback:** BASIC (`#compliant#`) und EXTENDED
> (`#conformant#`) sind keine XRechnung – die KoSIT-XRechnung-Konfig kennt dafür kein
> Szenario. Die API schreibt solche Profil-IDs **vorab** auf reines
> `urn:cen.eu:en16931:2017` um und prüft **einmal** gegen EN16931 (`profilFallback`
> gesetzt); ohne den Fix käme sonst „Dokumenttyp unbekannt". **MINIMUM/BASIC-WL**
> (ohne Positionsdaten) werden nicht umgeschrieben und im `hinweis` als „keine
> vollständige E-Rechnung" benannt.

Schneller Test (PowerShell):
```powershell
curl.exe -s -X POST "https://erechnung-xml2pdf.azurewebsites.net/api/intake?code=<KEY>&werk=WGC" `
  --data-binary "@C:\pfad\zur\rechnung.pdf" | ConvertFrom-Json |
  Format-List klassifizierung,werk,werkErkannt,werkMismatch,konform
```

---

## Power-Automate-Flow (pro Werk)

Je Werk ein Flow (das Werk-Kürzel ist im Flow fest), oder **ein** Flow, der das Werk
aus der Empfänger-Adresse ableitet. Ablauf:

1. **Trigger** *Wenn eine neue E-Mail eintrifft (V3)* auf dem Werks-Postfach
   (Shared Mailbox), Filter: **hat Anlagen** = ja, nur `.pdf`/`.xml`.

2. **Für jede Anlage** (`Apply to each` über `Anlagen`):

   a. **HTTP – POST an `/api/intake`**
      - URI `https://erechnung-xml2pdf.azurewebsites.net/api/intake?code=<KEY>&werk=WGC`
        (`WGC` = das Werk dieses Postfachs; bei einem gemeinsamen Flow dynamisch aus
        der Empfängeradresse)
      - Header `Content-Type: application/octet-stream`
      - Body = **Anlageninhalt**
      - **Kein** „Chunked"/`transferMode` (Azure Functions kann das nicht → sonst 400).

   b. **Dateibasis** (Compose): `basis = coalesce(body('HTTP')?['dateibasis'], <Anlagenname ohne Endung>)`.
      `dateibasis` = `<Nummer>_<StellerVat>` (bereinigt) — als Dateiname verwendet
      kollidieren zwei Lieferanten mit derselben Nummer nicht mehr (kein Überschreiben).

   c. **Original in `ERAR_<Werk>` ablegen** – *Datei erstellen*
      - Ordnerpfad: `ERAR_WGC` (bzw. `concat('ERAR_', <werk>)` beim gemeinsamen Flow)
      - Dateiname: `@{outputs('basis')}.pdf` / `.xml` (Anlagen-Endung übernehmen)
      - Dateiinhalt: Anlageninhalt → merkt sich die **ItemId** für Schritt e.

   d. **Sidecars** in dieselbe `ERAR_<Werk>` (nur wenn vorhanden; Basis = derselbe Name wie in c):
      - **XML:** `body('HTTP')?['xml']` → `@{outputs('basis')}.xml`
      - **Lesbares PDF:** `base64ToBinary(body('HTTP')?['lesbarPdfBase64'])` → `@{outputs('basis')}_lesbar.pdf`
      - **KoSIT-Bericht:** `body('HTTP')?['bericht']` → `@{outputs('basis')}_KoSIT-Bericht.xml`

   e. **Dateieigenschaften aktualisieren** (am in c erstellten Element):
      | Spalte | Wert |
      |--------|------|
      | `Title` | `body('HTTP')?['daten']?['nummer']` |
      | `Klassifizierung` | Mapping aus `klassifizierung` (zugferd→ZUGFeRD (PDF+XML), xrechnung-xml→XRechnung (XML), pdf-ohne-xml→PDF ohne E-Rechnung) |
      | `Format` | zugferd→ZUGFeRD · xrechnung-xml→XRechnung · pdf-ohne-xml→PDF |
      | `Richtung` | `Eingang` |
      | `Gesellschaft` | `body('HTTP')?['werk']` |
      | `Rechnungssteller` / `Rechnungsempfaenger` | `daten.steller` / `daten.empfaenger` |
      | `Rechnungsdatum` / `Faelligkeitsdatum` | `daten.datum` / `daten.faelligkeit` |
      | `Netto-/MwSt-/Bruttobetrag`, `Waehrung` | aus `daten` |
      | `Bestellnummer` / `Lieferscheinnummer` / `Kaeuferreferenz` | `daten.bestellnummer` / `…lieferscheinnummer` / `…leitwegid` |
      | `Konformitaet` | `body('HTTP')?['konformLabel']` |
      | `ValidierungsMeldung` | `body('HTTP')?['hinweis']` (fertiger Klartext-Satz) — **nicht** `join(meldungen)`, das ergäbe „[object Object]". Alternativ `meldungenText` (alle Befunde). |
      | `PDFAStatus` | aus `pdfa.konform`: ok→`PDF/A-3b ok` · fehler→`PDF/A Fehler` · xml→`n/a (nur XML)` · sonst `Ungeprueft` |
      | `KoSITBerichtUrl` / `LesbarPdfUrl` | WebUrl der Sidecars aus Schritt d |
      | `Verarbeitungsstatus` | `if(equals(body('HTTP')?['konform'],'rot'),'Fehler','Validiert')` |

   > **Dubletten braucht der Flow nicht zu prüfen.** Die Erkennung läuft automatisch im
   > Monitoring (`monitoring.js`, `_monMarkDupes`): gleiche Rechnungsnummer beim selben
   > Aussteller = „⚠ Dublette"-Badge + KPI-Kachel. Der `dateibasis`-Dateiname (Schritt b)
   > verhindert zusätzlich, dass sich verschiedene Lieferanten mit gleicher Nummer beim
   > Ablegen überschreiben. Optional kann der Flow vor Schritt c per *Dateimetadaten über
   > Pfad abrufen* auf `ERAR_<Werk>/@{outputs('basis')}.<ext>` prüfen (200 = existiert
   > bereits) und den Status `Dublette` setzen — nötig ist es für die Sichtbarkeit nicht.

   f. **Fehlleitung prüfen** – Bedingung `body('HTTP')?['werkMismatch']` = `true`:
      → `Fehlermeldung` = „Empfänger (@{body('HTTP')?['werkErkannt']}) ≠ Postfach-Werk
      – bitte Zuordnung prüfen" und ggf. `Verarbeitungsstatus = Fehler`. Die Datei
      bleibt im Werk, wird aber im Dashboard als Fehler sichtbar.

---

## Behandlung der drei Fälle

| Eingang | XML | Lesbares PDF | KoSIT | veraPDF | Klassifizierung |
|--------|-----|--------------|-------|---------|-----------------|
| **ZUGFeRD-PDF** | aus PDF extrahiert (Sidecar) | Original-PDF ist bereits lesbar | ja (+ Bericht) | ja (PDF/A-3b) | ZUGFeRD (PDF+XML) |
| **XRechnung-XML** | die empfangene XML | gerendert aus XML (`lesbarPdfBase64`) | ja (+ Bericht) | – | XRechnung (XML) |
| **Normales PDF** | – | Original-PDF | – (`Ungeprueft`) | ja (nur PDF/A-Info) | PDF ohne E-Rechnung |

**Normales PDF:** wird erkannt, gekennzeichnet und archiviert, aber **nicht**
automatisch in eine XRechnung umgewandelt (zuverlässige Auto-Konvertierung beliebiger
Lieferanten-Layouts ist nicht seriös leistbar). Bei Bedarf manuell in der E-Rechnung-App
umwandeln. Eine automatische OCR-Konvertierung wäre ein eigener, größerer Ausbau.

---

## Dubletten & Nummernkollisionen

Eine Rechnungsnummer ist **nur beim selben Aussteller** eindeutig — zwei Lieferanten
können dieselbe Nummer vergeben. Der Schlüssel ist daher **Nummer + Aussteller**, nie
die Nummer allein.

**Erkennung passiert automatisch im Monitoring** (`monitoring.js`, `_monMarkDupes`) —
**kein Flow-Schritt nötig**:

- **Echte Dublette** = gleiche Rechnungsnummer **und** gleicher Aussteller (im selben
  Werk/Richtung) → jede betroffene Zeile bekommt ein **„⚠ Dublette"-Badge**, dazu eine
  **KPI-Kachel „Dubletten"**. Der Sachbearbeiter sieht die Doppelerfassung sofort und
  entscheidet. Nichts wird automatisch gelöscht oder überschrieben.
- **Gleiche Nummer, verschiedene Lieferanten** ist **keine** Dublette: der Aussteller
  ist Teil des Schlüssels → wird nicht markiert.

Ergänzend liefert `/api/intake` den kollisionssicheren Dateinamen **`dateibasis`**
(`<Nummer>_<StellerVat>`): als Dateiname verwendet, überschreiben sich verschiedene
Lieferanten mit gleicher Nummer beim Ablegen nicht (und echte Dubletten bleiben als
getrennte Einträge sichtbar, statt sich zu ersetzen).

> **Ausgang (AR) ist nicht betroffen:** dort ist der Aussteller immer das Werk selbst,
> die Nummern sind pro Werk eindeutig und der Dateiname trägt zusätzlich das Datum.

---

## Was landet wo

- **`ERAR_<Werk>`**: geprüfte Eingangsrechnung mit Original, XML, lesbarem PDF und
  KoSIT-Bericht + gesetzten Metadaten. Das ist die Eingangsliste des Werks **und**
  Teil des Monitorings (das Dashboard aggregiert alle `ERAR_/AR_`; Aufbau, KPIs,
  Klartext-Hinweis und Dublettenerkennung: [`Rechnungsmonitoring.md`](Rechnungsmonitoring.md)).
- **`Rechnungseingang`** (optional): nur, falls es eine werk-neutrale Sammel-Adresse
  gibt – dann greift die Käufer-Erkennung als Router. Sonst nicht nötig.
