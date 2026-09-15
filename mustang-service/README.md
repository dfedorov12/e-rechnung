# Mustang-Validierung als Dienst

Validiert **ZUGFeRD/Factur-X** gegen das **tatsächlich deklarierte Profil**
(BASIC / EN 16931 / **EXTENDED**) und die PDF/A-Hülle — mit
[Mustangproject](https://www.mustangproject.org/). Der KoSIT-Dienst kann EXTENDED
nicht korrekt prüfen (er misst gegen die strenge EN16931/XRechnung-Bindung und meldet
zulässige Zusatzangaben als Fehler). Deshalb die Aufteilung:

```
/api/intake, /api/validate
   ├─ XRechnung-XML         ──▶  KoSIT-Dienst   (KOSIT_DAEMON_URL)
   └─ ZUGFeRD/Factur-X      ──▶  Mustang-Dienst (MUSTANG_URL)   ← dieser Ordner
```

Ergebnisform ist identisch zum KoSIT-Pfad (`api/src/mustang.js` mappt den Report auf
`{ konform, konformLabel, meldungen, meldungenText, hinweis, bericht }`), Monitoring und
Power-Automate-Flow bleiben unverändert.

## Bausteine
- **`Dockerfile`** — `eclipse-temurin:8-jre` + `Mustang-CLI.jar` + `python3` (Wrapper).
- **`server.py`** — schlanker HTTP-Server: `POST /` (PDF oder XML) →
  `java -jar Mustang-CLI.jar --action validate --source <datei>` → roher Report.
  `GET /` → Health.

## Bauen & deployen (Azure, ohne lokales Docker)

Aus dem Ordner `mustang-service` (Registry/RG wie beim KoSIT-Dienst):

```bash
# Image in der Cloud bauen
az acr build -r dihagerechnungacr -t erechnung-mustang:latest .

# Als Container App deployen (interne/externe Ingress wie beim KoSIT-Dienst)
az containerapp create \
  -g rg-erechnung-api \
  -n erechnung-mustang \
  --environment <euer-containerapp-env> \
  --image dihagerechnungacr.azurecr.io/erechnung-mustang:latest \
  --registry-server dihagerechnungacr.azurecr.io \
  --target-port 8080 --ingress external \
  --min-replicas 1 --cpu 1 --memory 2Gi
# -> Ingress-FQDN merken, z. B. https://erechnung-mustang.<hash>.<region>.azurecontainerapps.io
```

> Speicher: Mustang lädt beim ersten Aufruf Validierungsartefakte; **2 GiB** RAM und
> `min-replicas 1` (kein Kaltstart) sind empfehlenswert.

Danach die **App-Einstellung `MUSTANG_URL`** der Function App setzen (analog
`KOSIT_DAEMON_URL`):

```bash
az functionapp config appsettings set -g rg-erechnung-api -n erechnung-xml2pdf \
  --settings "MUSTANG_URL=https://erechnung-mustang.<hash>.<region>.azurecontainerapps.io/"
```

## Testen
```bash
curl -X POST --data-binary @rechnung.pdf https://erechnung-mustang.<...>/   # roher Report
# ODER ueber die Function:
curl -X POST "https://erechnung-xml2pdf.azurewebsites.net/api/validate?code=<KEY>" \
  -H "Content-Type: application/octet-stream" --data-binary @zugferd.pdf
# -> { konform, pruefwerkzeug: "Mustang (ZUGFeRD-Profil)", ... }
```

Verifikation gegen die EGH-EXTENDED-Rechnung (47835649): sollte **grün/gelb** liefern
statt der 7 EN16931-Fehlalarme des KoSIT-Pfads.
