# GoBD-Aufbewahrung – Spalte `GoBDArchiviert` aus dem echten Aufbewahrungslabel

`GoBDArchiviert` ist **kein** Haken, den man „von Hand" setzt und der dann etwas
beweist. Er soll den **tatsächlichen** Zustand spiegeln: liegt auf dem Element eine
**gesperrte Purview‑Aufbewahrung** (Unveränderbarkeit + Frist), oder nicht.

Deshalb zwei Teile:
1. **Purview** so einrichten, dass die Bibliotheken `ERAR_*`/`AR_*` unter einem
   gesperrten Aufbewahrungslabel liegen (das ist der eigentliche GoBD‑Nachweis).
2. **Power Automate** liest das angewandte Label pro Datei und setzt `GoBDArchiviert`
   entsprechend (Ja nur, wenn das Label wirklich anliegt).

> Ohne Teil 1 bleibt der Haken ehrlicherweise **Nein** — eine SharePoint‑Ablage
> allein ist nicht revisionssicher (Admins könnten löschen).

---

## Teil 1 – Purview-Aufbewahrungslabel (einmalig)

Microsoft Purview → **Records Management / Aufbewahrungsbezeichnungen**:

1. **Label erstellen**, z. B. `GoBD Rechnungen 8 Jahre`
   - Aufbewahren für **8 Jahre** (Rechnungen/Buchungsbelege, seit Wachstumschancengesetz),
   - Beginn ab **Erstellungs-/Ablagedatum**,
   - als **Datensatz (Record)** kennzeichnen → macht das Element unveränderbar,
   - Aktion nach Ablauf: nichts / zur Prüfung (nicht auto‑löschen ohne Freigabe).
2. **Label veröffentlichen oder automatisch anwenden** auf die
   Rechnungsmonitoring‑Site bzw. gezielt die Bibliotheken `ERAR_*`/`AR_*`.
   Am robustesten: das Label als **Standard‑Aufbewahrungslabel der Bibliothek**
   setzen → jede neue Datei erhält es automatisch.
3. **Preservation Lock** auf die zugehörige Aufbewahrungs**richtlinie** setzen,
   damit selbst globale Admins Frist/Umfang nicht mehr verkürzen oder entfernen
   können. **Erst damit** ist die Aufbewahrung revisionssicher.

Der genaue **Labelname** (`GoBD Rechnungen 8 Jahre`) wird unten im Flow gebraucht —
bitte exakt so verwenden, wie er in Purview heißt.

---

## Teil 2 – Power Automate: Label lesen und `GoBDArchiviert` setzen

Im selben „on file created"-Flow (nach der Validierung) diese drei Schritte:

### 2a) Aktion „SharePoint – **HTTP-Anforderung an SharePoint senden**"

Liest das angewandte Aufbewahrungslabel (`_ComplianceTag`) des Elements. Delegiert –
kein zusätzliches App-Recht nötig.

| Feld | Wert |
|------|------|
| Websiteadresse | `https://dihag.sharepoint.com/sites/Rechnungsmonitoring` |
| Methode | `GET` |
| URI | `_api/web/lists/getByTitle('AR_SHB')/items(@{triggerBody()?['ID']})?$select=_ComplianceTag` |
| Header | `Accept` : `application/json;odata=nometadata` |

- `AR_SHB` durch den Bibliotheksnamen des jeweiligen Flows ersetzen (bzw.
  dynamisch, wenn ein Flow mehrere Bibliotheken bedient).
- `triggerBody()?['ID']` ist die Element-ID aus dem Trigger.

Als Code (Aktions-JSON):

```json
{
  "type": "OpenApiConnection",
  "inputs": {
    "parameters": {
      "dataset": "https://dihag.sharepoint.com/sites/Rechnungsmonitoring",
      "method": "GET",
      "uri": "_api/web/lists/getByTitle('AR_SHB')/items(@{triggerBody()?['ID']})?$select=_ComplianceTag",
      "headers": { "Accept": "application/json;odata=nometadata" }
    },
    "host": {
      "apiId": "/providers/Microsoft.PowerApps/apis/shared_sharepointonline",
      "connection": "shared_sharepointonline",
      "operationId": "HttpRequest"
    }
  }
}
```

### 2b) Bedingung: liegt das GoBD-Label an?

`_ComplianceTag` ist leer, wenn **kein** Label anliegt; sonst enthält es den
**Labelnamen** (plus interne Zusätze, per `|` getrennt). Deshalb auf „enthält den
Labelnamen" prüfen:

- Bedingung: Ausdruck
  ```
  contains(coalesce(body('HTTP-Anforderung_an_SharePoint_senden')?['_ComplianceTag'], ''), 'GoBD Rechnungen 8 Jahre')
  ```
  **ist gleich** `true`.

(`GoBD Rechnungen 8 Jahre` = euer Labelname aus Teil 1.)

### 2c) Aktion „SharePoint – Dateieigenschaften aktualisieren"

- **Wenn ja:** `GoBDArchiviert` = **Ja** (true)
- **Wenn nein:** `GoBDArchiviert` = **Nein** (false)

Damit ist der Haken **an den tatsächlichen Aufbewahrungszustand gekoppelt** und
behauptet keine Revisionssicherheit, die nicht besteht.

---

## Hinweise

- **Fallback, falls `_ComplianceTag` nicht zurückkommt:** In „Dateieigenschaften
  abrufen" gibt es je nach Tenant die Spalte **„Aufbewahrungsbezeichnung"** – die
  kann man alternativ auslesen. Einmal eine Datei mit Label ablegen und die
  Rohantwort ansehen, um das exakte Format zu bestätigen.
- **Steuerlicher Abschluss:** Frist, Record-Deklaration und Verfahrensdokumentation
  gehören vom Steuerberater/der Wirtschaftsprüfung abgenommen – dieser Mechanismus
  liefert nur den technischen Nachweis „Label liegt an".
- Solange in Purview noch **kein gesperrtes Label** aktiv ist, bleibt `GoBDArchiviert`
  korrekterweise **Nein**.
