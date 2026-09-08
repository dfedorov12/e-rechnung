# veraPDF (PDF/A-3b) als Dienst

Zweite Prüfebene neben KoSIT: **veraPDF** prüft die **PDF/A-3b-Hülle** eines
ZUGFeRD/Factur-X-PDF (technisch valides Archiv-PDF). KoSIT prüft den **Inhalt**
(EN 16931 / XRechnung) — beides zusammen ergibt die vollständige ZUGFeRD-Prüfung.

```
/api/validate  ──(PDF)──▶  extrahiert XML ──▶ KoSIT-Daemon      (Inhalt -> Konformitaet)
                     └────  PDF komplett  ──▶ veraPDF-Dienst     (Huelle -> PDFAStatus)
```

Der Dienst ist ein **Node-Wrapper** um die veraPDF-CLI (Java): `POST /` mit einem
PDF liefert JSON `{ konform: "ok"|"fehler", flavour: "PDF/A-3b", compliant, meldungen[] }`.

## 1) Container bauen & deployen (ohne lokales Docker)

Aus dem Ordner `verapdf-service`:

```bash
az acr build -r dihagerechnungacr -t erechnung-verapdf:latest .

az container create \
  -g rg-erechnung-api \
  --name erechnung-verapdf \
  --image dihagerechnungacr.azurecr.io/erechnung-verapdf:latest \
  --registry-login-server dihagerechnungacr.azurecr.io \
  --registry-username dihagerechnungacr \
  --registry-password "$(az acr credential show -n dihagerechnungacr --query 'passwords[0].value' -o tsv)" \
  --os-type Linux --ports 8080 --cpu 1 --memory 2 \
  --dns-name-label erechnung-verapdf
# -> http://erechnung-verapdf.<region>.azurecontainer.io:8080/
```

> Wie beim KoSIT-Dienst: **keine eigene Auth** — nur intern erreichbar halten.

## 2) Function verbinden

```bash
az functionapp config appsettings set -g rg-erechnung-api -n erechnung-xml2pdf \
  --settings VERAPDF_URL="http://erechnung-verapdf.<region>.azurecontainer.io:8080/"

cd ../api && npm run sync && func azure functionapp publish erechnung-xml2pdf
```

Ist `VERAPDF_URL` **nicht** gesetzt, überspringt `/api/validate` den PDF/A-Check
(kein Fehler) — dann fehlt nur das Feld `pdfa` in der Antwort.

## 3) Antwort von `/api/validate` bei einem PDF

```json
{
  "konform": "gruen", "konformLabel": "Gruen - KoSIT ok", "accepted": true,
  "quelle": "ZUGFeRD-PDF",
  "pdfa": { "konform": "ok", "flavour": "PDF/A-3b", "compliant": true, "meldungen": [] }
}
```

## 4) Power Automate — neue Spalte setzen

Beim „Dateieigenschaften aktualisieren" zusätzlich:

| Spalte | Wert |
|---|---|
| `PDFAStatus` | `if(equals(body('JSON')?['pdfa']?['konform'],'ok'),'PDF/A-3b ok', if(equals(body('JSON')?['pdfa']?['konform'],'fehler'),'PDF/A Fehler','Ungeprueft'))` |

Für reine XML-Dateien (kein PDF) gibt es kein `pdfa` → dort `PDFAStatus` = `n/a (nur XML)`.

Die Spalte `PDFAStatus` wird von `scripts/provision-rechnungsmonitoring.ps1`
angelegt — Skript einmal erneut ausführen, damit sie in den Bibliotheken existiert.

## Version

veraPDF **1.26.2** (Greenfield) — identisch zur CI (`.github/workflows/validate.yml`).
