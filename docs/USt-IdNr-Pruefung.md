# Qualifizierte USt-IdNr-Prüfung (Ausgangsrechnungen)

Beim manuellen Hinzufügen einer PDF im Tool (`index.html`) kann die **USt-IdNr. des
Rechnungsempfängers** qualifiziert bestätigt werden – mit **Nachweis** (Anfrage-ID).
Relevant für innergemeinschaftliche Lieferungen / Reverse Charge (§ 6a UStG).

## Ablauf

```
index.html  →  Button „🛡 USt-IdNr. qualifiziert prüfen"
   liest Empfänger-Felder (kaeufer-vat, kaeufer, kaeufer-stadt/-plz/-strasse)
   + eigene USt-IdNr (verkaeufer-vat)
        ↓  POST /api/vat  (js/vat.js → Azure Function)
   BZSt eVatR REST (qualifiziert)  ──Ausfall──►  EU-VIES (Fallback)
        ↓
   Ergebnis-Panel: gültig? + Feldabgleich (Name/Ort/PLZ/Straße) + Bericht
        ↓  „Bericht drucken" / „Als Text kopieren"
```

## Server: `/api/vat`

`POST /api/vat` (authLevel **anonymous**, CORS für die App-Domain frei) ·
Body `{ vatIdOwn, vatId, company, city, zip, street }`.

- **`vatIdOwn`** = eigene deutsche USt-IdNr (Anfragender, `DE…`).
- **`vatId`** = zu prüfende **ausländische** EU-USt-IdNr. Bei `DE…` liefert der
  Endpoint `moeglich:false` (Inland braucht keine qualifizierte Bestätigung).
- `company` + `city` → qualifizierte Bestätigung; ohne sie nur einfache (Gültigkeit).

**Primär BZSt** (`api/src/bzst.js`): neue REST-API `https://api.evatr.vies.bzst.de/app/v1/abfrage`
(seit 01.07.2025; alte XML-RPC seit 30.11.2025 aus). Antwort: `status` (evatr-XXXX),
`id` (Nachweis), `anfrageZeitpunkt`, `gueltigAb/Bis`, Feldcodes
`ergFirmenname/ergOrt/ergPlz/ergStrasse` = **A** (stimmt überein) / **B** (nein) /
**C** (nicht angefragt) / **D** (vom EU-Staat nicht mitgeteilt). Kein Zertifikat/Key nötig.

**Fallback EU-VIES** (`api/src/vies.js`), wenn BZSt nicht erreichbar ist (Wartungsfenster):
`https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number` → `valid`,
`requestIdentifier` (Anfragekennung) + für viele Staaten registrierter Name/Adresse.

Ergebnisse werden **12 h gecacht** (BZSt-Rate-Limits schonen).

## Bericht (Nachweis)

Die API liefert ein `bericht`-Objekt (Titel + Zeilen), das Panel zeigt es und bietet
**Drucken** (eigenes Fenster, druckfertig) und **Kopieren**. Inhalt: Quelle, Art
(qualifiziert/einfach), anfragende + geprüfte USt-IdNr, Gültigkeit, Statusmeldung,
Feldabgleich, **Anfrage-ID**, Zeitpunkt. Das global hinterlegte `window._letzteVatPruefung`
kann später an Export/Monitoring angehängt werden.

## Grenzen / offen (PoC)

- Greift nur für **EU-Ausland** (nicht DE); der Button meldet DE/Inland entsprechend.
- `/api/vat` ist **anonymous** (BZSt/VIES sind selbst offen, kein Geheimnis im Spiel);
  für Produktion ließe sich der Zugriff über das MSAL-Token der App absichern.
- **Anhängen erledigt:** Beim Export wird der Bericht (sofern zur aktuellen
  Empfänger-USt-IdNr geprüft) automatisch mitgenommen:
  - **ZUGFeRD-PDF:** als zusätzlicher Anhang `USt-IdNr-Bestaetigung.txt`
    (afRelationship `Supplement`; PDF/A-3b bleibt konform, factur-x.xml bleibt
    maßgeblich — beides mit veraPDF/KoSIT verifiziert).
  - **Monitoring** (`AR_<Werk>`): Spalten `UStIdStatus`, `UStIdAnfrageId`,
    `UStIdPruefzeitpunkt`, `UStIdBericht` (per `provision-rechnungsmonitoring.ps1`
    anlegen). Gilt für ZUGFeRD **und** XRechnung-Export.
- Amtliche **postalische** Bestätigungsmitteilung ist separat; die gespeicherte
  API-Antwort (Anfrage-ID + Zeitpunkt + Codes) ist der elektronische Nachweis.
