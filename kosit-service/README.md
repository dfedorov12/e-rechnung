# KoSIT-Validierung als Dienst

Damit die Spalte **Konformität** im Rechnungsmonitoring automatisch auf
**grün / gelb / rot** springt, prüft ein Dienst jede neue Datei mit dem
**echten KoSIT-Validator**. Der Browser-Konverter kann das nicht (KoSIT ist Java).

## Bausteine

```
Power Automate  ──POST XML──▶  Azure Function /api/validate  ──POST XML──▶  KoSIT-Daemon (Container)
   (on file created)              (JSON-Verdikt: gruen/gelb/rot)              (offizieller Validator, Java 8)
        │
        └──▶ SharePoint: Spalte "Konformitaet" + "ValidierungsMeldung" setzen
```

1. **`kosit-service/`** (dieser Ordner): Container mit dem KoSIT-Validator im
   **Daemon-Modus** (HTTP). Enthält die XRechnung-Konfiguration fest eingebaut.
2. **`api/src/functions/validate.js`**: dünner JSON-Wrapper in der bestehenden
   Azure Function — nimmt die XML, ruft den Daemon, liefert ein sauberes
   `{ konform, konformLabel, accepted, meldungen }` zurück.
3. **Power Automate**: ruft `/api/validate` und schreibt das Ergebnis in die
   SharePoint-Spalten.

## 1) Container bauen & deployen

```bash
cd kosit-service
docker build -t erechnung-kosit .
docker run -p 8080:8080 erechnung-kosit          # lokal testen
curl -X POST --data-binary @rechnung.xml http://localhost:8080/   # liefert Report-XML
```

Der Daemon:
- `POST /` mit XML-Body → **Report-XML** (HTTP 200 auch bei „rejected"; das
  Urteil steht im Report — der Wrapper wertet es aus).
- `GET /` → HTML-Upload-Seite (dient als Liveness-Check).

**Nach Azure** (z. B. Azure Container Registry + Container Instances):

```bash
az acr build -r <registry> -t erechnung-kosit:latest .

az container create \
  --resource-group rg-erechnung-api \
  --name erechnung-kosit \
  --image <registry>.azurecr.io/erechnung-kosit:latest \
  --ports 8080 \
  --cpu 1 --memory 1.5 \
  --dns-name-label erechnung-kosit
# -> http://erechnung-kosit.<region>.azurecontainer.io:8080/
```

> **Sicherheit:** Der Daemon hat **keine eigene Authentifizierung**. Er sollte
> nur intern erreichbar sein — idealerweise Function + Container im selben VNet,
> oder per IP-Restriction auf die Function. Nicht offen ins Internet stellen.

## 2) Azure Function verbinden

In der Function-App eine App-Einstellung setzen:

```bash
az functionapp config appsettings set -g rg-erechnung-api -n erechnung-xml2pdf \
  --settings KOSIT_DAEMON_URL="http://erechnung-kosit.<region>.azurecontainer.io:8080/"
```

Danach die API neu deployen (bringt die neue Function `validate` mit):

```bash
cd ../api && npm run sync && func azure functionapp publish erechnung-xml2pdf
```

Test:

```bash
curl "https://erechnung-xml2pdf.azurewebsites.net/api/validate?code=<KEY>" \
  -H "Content-Type: application/xml" --data-binary @rechnung.xml
# -> { "konform": "gruen", "konformLabel": "Gruen - KoSIT ok", "accepted": true, ... }
```

## 3) Power-Automate-Flow (je Bibliothek ERAR_/AR_)

| Schritt | Aktion | Wert |
|--------|--------|------|
| Trigger | SharePoint · **Wenn eine Datei erstellt wird** | Bibliothek `ERAR_<Werk>` bzw. `AR_<Werk>` |
| 1 | SharePoint · **Dateiinhalt abrufen** | Datei-ID aus Trigger |
| 2 | (Bedingung) Dateiname endet mit `.xml` | XRechnung/CII/UBL |
| 3 | **HTTP** | `POST https://erechnung-xml2pdf.azurewebsites.net/api/validate?code=<KEY>`, Header `Content-Type: application/xml`, Body = Dateiinhalt |
| 4 | **JSON analysieren** | Schema aus einer Beispielantwort |
| 5 | SharePoint · **Dateieigenschaften aktualisieren** | `Konformitaet` = `konformLabel`, `ValidierungsMeldung` = erste Meldungen, `Verarbeitungsstatus` = `Validiert` (bzw. `Fehler`, wenn `konform` = `rot`) |

Antwort-JSON von `/api/validate`:

```json
{
  "konform": "rot",
  "konformLabel": "Rot - Fehler",
  "accepted": false,
  "errorCount": 1,
  "warningCount": 0,
  "meldungen": [
    { "level": "error", "code": "BR-DE-15", "text": "[BR-DE-15] Die Leitweg-ID (BT-10) fehlt." }
  ]
}
```

`konformLabel` passt 1:1 auf die Choice-Werte der Spalte **Konformitaet**
(`Gruen - KoSIT ok`, `Gelb - Warnungen`, `Rot - Fehler`).

## Hinweise / Grenzen

- **ZUGFeRD-PDF (`AR_*` mit .pdf):** der Wrapper prüft **XML**. Für ZUGFeRD müsste
  Power Automate die eingebettete XML extrahieren (oder ein zusätzlicher Schritt
  im Container/der Function) — als nächster Ausbau vorgesehen. XRechnung-XML
  (der häufigste Fall, auch die Konverter-Ausgaben) ist voll abgedeckt.
- **PDF/A (veraPDF):** analog als zweiter Prüfschritt ergänzbar; hier zunächst
  KoSIT (EN 16931 / XRechnung).
- Versionen: KoSIT-Validator `1.5.0`, XRechnung-Konfiguration `release 2024-06-20`
  (3.0.2) — identisch zur CI (`.github/workflows/validate.yml`). Beim Aktualisieren
  beide Stellen gleich ziehen.
