# E-Rechnung · XML → PDF API (Azure Function)

Serverseitiger HTTP-Endpunkt, der eine **E-Rechnungs-XML** (XRechnung / ZUGFeRD,
Syntax CII oder UBL) entgegennimmt und ein **lesbares PDF** zurückliefert – für
die Nutzung aus **Power Automate** (POST/GET), **ohne M365-Anmeldung**.

Die Function führt **exakt denselben Konverter** aus wie die Web-App:
`js/xmlinvoice.js` (XML → Datenobjekt) und `js/xml2pdf.js` (Datenobjekt → PDF).

---

## Warum eine Azure Function und nicht die Webseite?

`xml-zu-pdf.html` liegt auf **GitHub Pages** – einem reinen *statischen*
Dateiserver. Die Umwandlung passiert dort **im Browser** (JavaScript). Ein
POST/GET von Power Automate gegen die HTML-Seite bekäme nur den **HTML-Quelltext**
zurück – das JavaScript läuft nie, es gibt keinen Server, der eine XML annimmt.

Für einen automatisierbaren Endpunkt braucht es also serverseitige Ausführung.
Diese Function ist genau das: ein schlanker Node-Wrapper, der den vorhandenen
Konverter im Server ausführt.

> **Wichtig:** Die Function hat eine **eigene URL** (`https://<app>.azurewebsites.net`),
> **nicht** `e-rechnung.dihag-extern.com`. Optional lässt sich eine eigene Domäne
> (z. B. `api.e-rechnung.dihag-extern.com`) auf die Function App mappen.

---

## Architektur / Single Source of Truth

```
e-rechnung/
├─ js/xmlinvoice.js   ← Browser + Server nutzen dieselbe Datei
├─ js/xml2pdf.js
└─ api/               ← dieses Function-Projekt
   ├─ src/functions/convert.js   HTTP-Trigger (GET Info / POST XML→PDF)
   ├─ src/converter.js           lädt vendor/-Module im Host-Realm
   ├─ scripts/sync.js            kopiert ../js/*.js → vendor/
   ├─ vendor/                    (generiert, .gitignore) synchronisierte Kopien
   ├─ host.json  package.json  .funcignore
   └─ test/                      lokaler Smoketest ohne Azure
```

`npm run sync` kopiert die beiden Live-Module aus `../js` nach `vendor/`.
`converter.js` lädt sie per `new Function(...)` im **Host-Realm** (nicht in einer
vm-Sandbox – sonst schlägt die `instanceof`-Prüfung in pdf-lib fehl). So bleibt
die Server-Ausgabe garantiert identisch zur Browser-Ausgabe und läuft nie
auseinander: Konverter-Fix im Browser → einfach neu deployen.

---

## Voraussetzungen

- **Node.js 18+** (getestet mit 18.20)
- **Azure Functions Core Tools v4** – `npm i -g azure-functions-core-tools@4`
- **Azure CLI** – `az` (für die einmalige Erstellung der Ressourcen)
- Eine **Azure-Subscription** (DIHAG)

---

## Lokal testen

```bash
cd api
npm install
npm test          # sync + Smoketest: konvertiert test/sample-cii.xml → test/out.pdf
```

Als echter HTTP-Server lokal:

```bash
cp local.settings.json.example local.settings.json
npm start         # startet func auf http://localhost:7071
```

```bash
# Info (GET)
curl http://localhost:7071/api/convert

# Konvertieren (POST) – PDF wird gespeichert
curl -X POST http://localhost:7071/api/convert \
     -H "Content-Type: application/xml" \
     --data-binary "@test/sample-cii.xml" \
     -o rechnung.pdf
```

---

## Nach Azure deployen (einmalig einrichten)

Namen anpassen; **Storage-Account-Name muss global eindeutig** sein (3–24
Kleinbuchstaben/Ziffern). Region z. B. `germanywestcentral`.

```bash
az login

az group create \
  --name rg-erechnung-api \
  --location germanywestcentral

az storage account create \
  --name sterechnungapi001 \
  --resource-group rg-erechnung-api \
  --location germanywestcentral \
  --sku Standard_LRS

az functionapp create \
  --resource-group rg-erechnung-api \
  --consumption-plan-location germanywestcentral \
  --runtime node \
  --runtime-version 20 \
  --functions-version 4 \
  --os-type Linux \
  --name erechnung-xml2pdf \
  --storage-account sterechnungapi001
```

Deployen (aus dem Ordner `api/`):

```bash
npm run sync          # vendor/ mit aktuellem Konverter füllen (WICHTIG vor jedem Deploy)
func azure functionapp publish erechnung-xml2pdf
```

Danach lautet der Endpunkt:

```
https://erechnung-xml2pdf.azurewebsites.net/api/convert
```

> **Bei jeder Konverter-Änderung** (in `js/`): erneut `npm run sync` +
> `func azure functionapp publish erechnung-xml2pdf`.

---

## Nutzung in Power Automate

**1) XML konvertieren – Aktion „HTTP"**

| Feld           | Wert |
|----------------|------|
| Method         | `POST` |
| URI            | `https://erechnung-xml2pdf.azurewebsites.net/api/convert` |
| Headers        | `Content-Type` : `application/xml` |
| Body           | der XML-Inhalt (z. B. Dateiinhalt aus „SharePoint – Datei-Inhalt abrufen") |

Die Antwort (**Body** der HTTP-Aktion) ist das **PDF (Binärdaten)**.

**2) PDF ablegen – z. B. „SharePoint – Datei erstellen" / „OneDrive – Datei erstellen"**

| Feld          | Wert |
|---------------|------|
| Dateiname     | `rechnung.pdf` (oder dynamisch, siehe unten) |
| Dateiinhalt   | **Body** der HTTP-Aktion |

Hilfreiche Antwort-Header:
- `X-Invoice-Number` – Rechnungsnummer (URL-encodiert), gut für den Dateinamen
- `X-Invoice-Syntax` – `CII` oder `UBL`
- `X-Invoice-Positions` – Anzahl Positionen
- `Content-Disposition` – enthält den vorgeschlagenen Dateinamen

**GET zum Testen der Erreichbarkeit** (liefert eine kleine JSON-Info):

```
GET https://erechnung-xml2pdf.azurewebsites.net/api/convert
```

---

## Sicherheit

Standard: **`authLevel: "anonymous"`** – bewusst offen, damit Power Automate ohne
M365 zugreifen kann. Der Konverter enthält keine Geheimnisse und **speichert
nichts** (die XML wird nur im Arbeitsspeicher verarbeitet und sofort verworfen).

**Optional – einfacher Schutz per Function-Key** (verhindert wahllose Nutzung
durch Dritte, ohne M365):

1. In `src/functions/convert.js` `authLevel` von `'anonymous'` auf `'function'`
   ändern, neu deployen.
2. Key holen: `az functionapp keys list -g rg-erechnung-api -n erechnung-xml2pdf`
   (oder im Portal → Function → *App keys*).
3. In Power Automate den Key als Query anhängen:
   `.../api/convert?code=<FUNCTION_KEY>`.

**CORS** ist für Power Automate irrelevant (Server-zu-Server). Nur nötig, falls
die Function jemals direkt aus einem Browser (JavaScript) aufgerufen werden soll
– dann im Portal unter *API → CORS* die erlaubte Origin eintragen.

---

## Datenschutz

- Keine Persistenz: die hochgeladene XML und das erzeugte PDF werden **nicht**
  gespeichert.
- Application Insights (falls aktiviert) protokolliert Metadaten/Fehler, **keine**
  Rechnungsinhalte. Bei Bedarf in `host.json` bzw. der App-Konfiguration abschalten.
