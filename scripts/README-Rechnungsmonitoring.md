# Rechnungsmonitoring – SharePoint-Bibliotheken + Dashboard

Zentrale Übersicht über **alle** Eingangs- und Ausgangsrechnungen aller Werke/ERP‑Systeme
auf **einer** SharePoint‑Site, plus eine eigene Monitoring‑Website als Auswertung.

## Struktur

Eine Site (z. B. `.../sites/Rechnungsmonitoring`), darauf **je Werk zwei Bibliotheken**:

| Bibliothek   | Inhalt                              |
|--------------|-------------------------------------|
| `ERAR_<Werk>`| Eingangsrechnungen (Archiv)         |
| `AR_<Werk>`  | Ausgangsrechnungen                  |

**Werke (Standard, 10 Stück):** `WGC, SHB, EIS, DSO, LEG, EWA, HOL, MEG, SCH, ZAI`
→ 10 Werke × 2 Richtungen = **20 Bibliotheken**.

Neues Werk = ein Eintrag mehr in `-Werke` (oder in der Standardliste im Skript),
Skript erneut ausführen → zwei neue Bibliotheken mit identischem Spaltensatz. Die internen Spaltennamen sind **gleich**
denen, die der Konverter (`js/sharepoint.js`) schreibt → ERP‑Automatik und Konverter
sind spaltenkompatibel.

## 1) Bibliotheken provisionieren (PnP.PowerShell)

Einmalig App registrieren (PnP 2.x braucht eine eigene Entra‑App):

```powershell
Install-Module PnP.PowerShell -Scope CurrentUser
Register-PnPEntraIDAppForInteractiveLogin -ApplicationName "DIHAG-Rechnungsmonitoring" -Tenant dihag.onmicrosoft.com
```

**Ein‑Klick (Site + Bibliotheken in einem)** – legt die Site an, falls sie noch
nicht existiert, und provisioniert anschließend alle Bibliotheken/Spalten:

```powershell
.\setup-rechnungsmonitoring.ps1 `
    -SiteUrl https://dihag.sharepoint.com/sites/Rechnungsmonitoring `
    -ClientId <APP-ID>
```

**Nur Bibliotheken** (Site existiert bereits) – ohne `-Werke` werden alle 10
Standard‑Werke angelegt; SHB/WGC bestehen schon und werden übersprungen:

```powershell
.\provision-rechnungsmonitoring.ps1 `
    -SiteUrl https://dihag.sharepoint.com/sites/Rechnungsmonitoring `
    -ClientId <APP-ID>
```

Nur einzelne / neue Werke nachziehen:

```powershell
.\provision-rechnungsmonitoring.ps1 `
    -SiteUrl https://dihag.sharepoint.com/sites/Rechnungsmonitoring `
    -ClientId <APP-ID> `
    -Werke EIS,DSO,LEG,EWA,HOL,MEG,SCH,ZAI
```

Trockenlauf: beim Provision‑Skript zusätzlich `-WhatIfOnly`. Beide Skripte sind
idempotent – vorhandene Site/Bibliotheken/Spalten werden übersprungen; die
`Gesellschaft`‑Auswahl wird auch auf bestehenden Bibliotheken auf alle 10 Werke
aktualisiert. Der angemeldete Benutzer braucht das Recht, Site Collections anzulegen.

## Spaltensatz (je Bibliothek)

- **Kern** (Konverter schreibt): Rechnungsnummer (`Title`), Rechnungsart (BT‑3),
  Rechnungsdatum, Rechnungssteller, Rechnungsempfaenger, Netto/MwSt/Brutto,
  Format, Gesellschaft, XML‑/PDF‑URL, OriginalPdfName.
- **Zusatz‑Metadaten**: USt‑IdNr., Währung, Fälligkeit, Käuferreferenz (BT‑10),
  Bestellnummer (BT‑13), Lieferscheinnummer (BT‑16), Zahlungsreferenz (BT‑83).
- **Monitoring**: Richtung, ERP‑Quelle, Syntax (CII/UBL), Verarbeitungsstatus,
  Konformität, Validierungs-/Fehlermeldung, Eingangs-/Konvertierzeitpunkt.
- **Prüfpfad/GoBD** (Konverter schreibt): Pruefstatus, ManuelleAenderungen,
  QuellPdfHash, XmlHash, GeprueftVon, StammdatenEntsperrt, GoBDArchiviert.

`Richtung` und `Gesellschaft` bekommen je Bibliothek einen passenden Default,
damit automatisch eingelieferte Dateien direkt korrekt getaggt sind.

## 2) Automatischer Eingang (ERP → Bibliothek)

Pro Werk liefert das ERP-/Power‑Automate‑Flow die Rechnung in `ERAR_<Werk>`
(bzw. Ausgang in `AR_<Werk>`) und setzt die Felder. E‑Rechnungen (XRechnung/ZUGFeRD)
können dabei über die **XML→PDF‑API** (`api/`) zusätzlich als lesbares PDF/A abgelegt
werden. Verarbeitungsstatus/Konformität kommen aus der Validierung.

## 3) Monitoring‑Website (Auswertung)

Eigene SPA (MSAL + Graph, GitHub‑Pages‑Muster wie die übrigen DIHAG‑Apps). Liest via
Graph **alle** Bibliotheken der Site (`/sites/{id}/lists?$filter=...` bzw. `/drives`),
aggregiert die Listenelemente und zeigt:

- KPI‑Kacheln: Anzahl je Verarbeitungsstatus, Konformität (grün/gelb/rot), offene Fehler.
- Filter: Werk, Richtung (Eingang/Ausgang), Zeitraum, Format, Status.
- Tabelle je Rechnung mit Deep‑Link in die SharePoint‑Datei.
- Trend: Eingänge/Konvertierungen pro Tag/Monat.

→ Noch zu bauen (eigenes Repo, z. B. `dfedorov12/rechnungsmonitoring`, Custom Domain
`rechnungsmonitoring.dihag-extern.com`) oder als Reiter in der E‑Rechnung‑App.
