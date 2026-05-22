# Entwicklungsdokumentation — E-Rechnung Konverter
**ITIL-konforme Technische Dokumentation**

---

## Dokumentenkontrolle

| Attribut | Wert |
|---|---|
| Dokumenten-ID | DIHAG-ERECH-DEV-001 |
| Version | 1.2 |
| Status | Freigegeben |
| Erstellt am | 21.05.2026 |
| Zuletzt geändert | 22.05.2026 |
| Autor | Denis Fedorov, DIHAG |
| Klassifizierung | Intern |
| Repository | https://github.com/dfedorov12/e-rechnung |
| Produktiv-URL | https://dfedorov12.github.io/e-rechnung/ |

### Revisionshistorie

| Version | Datum | Autor | Beschreibung |
|---|---|---|---|
| 1.0 | 21.05.2026 | D. Fedorov | Initiales Release: XRechnung, MSAL-Auth, SharePoint-Integration, PDF-Parser |
| 1.1 | 22.05.2026 | D. Fedorov | ZUGFeRD PDF/A-3-Konformität, XRechnung BR-DE-Korrekturen |
| 1.2 | 22.05.2026 | D. Fedorov | PEPPOL-Validierung, vollständige Pflichtfeldlogik, Compliance-Footer |

---

## 1. Service-Übersicht (Service Catalogue)

### 1.1 Service-Steckbrief

| Attribut | Wert |
|---|---|
| Service-Name | E-Rechnung Konverter |
| Service-Typ | Interne Webanwendung (Self-Service-Tool) |
| Service-Eigentümer | DIHAG IT |
| Benutzergruppe | DIHAG-Mitarbeiter (authentifiziert über Microsoft Entra ID) |
| Hosting | GitHub Pages (statisch, kein Backend-Server) |
| Verfügbarkeit | Abhängig von GitHub Pages SLA (99,9 %) |
| Datenhaltung | Ausschließlich Browser-LocalStorage + Microsoft SharePoint |

### 1.2 Servicebeschreibung

Der E-Rechnung Konverter ist eine browserbasierte Eigenentwicklung der DIHAG zur Erstellung gesetzeskonformer elektronischer Rechnungen. Die Anwendung unterstützt zwei Ausgabeformate:

- **XRechnung 3.0** (reines XML, CII UN/CEFACT) — für öffentliche Auftraggeber (B2G)
- **ZUGFeRD 2.4 / Factur-X 1.08** (PDF mit eingebettetem XML, EN 16931) — für B2B und B2G

Der Service ersetzt manuelle Rechnungserstellung und stellt sicher, dass erzeugte Dokumente den normativen Anforderungen der EN 16931, der XRechnung-Spezifikation 3.0 sowie den PEPPOL-BIS-Billing-3.0-Regeln genügen.

### 1.3 Rechtlicher Rahmen

| Norm / Vorschrift | Relevanz |
|---|---|
| EU-Richtlinie 2014/55/EU | Pflicht zur elektronischen Rechnungsstellung an öffentliche Auftraggeber |
| EN 16931-1:2017 | Semantisches Datenmodell für elektronische Rechnungen |
| XRechnung 3.0 (KoSIT / xeinkauf.de) | Deutsche Syntaxbindung für öffentliche Auftraggeber |
| ZUGFeRD 2.4 / Factur-X 1.08 (FNFE/FeRD) | Hybridformat PDF/A-3 + XML |
| PEPPOL BIS Billing 3.0 | Interoperabilitätsrahmen für elektronische Rechnungen |
| § 14 UStG | Rechnungsangaben im deutschen Steuerrecht |
| GoBD | Grundsätze ordnungsmäßiger Buchführung (Unveränderlichkeit) |

> **Haftungshinweis:** Die Software erzeugt XML/PDF-Dokumente nach bestem technischen Wissen. Die steuerliche und rechtliche Verantwortung für die Korrektheit aller Rechnungsangaben liegt beim Rechnungsaussteller. Die Software ist nicht durch KoSIT oder FNFE zertifiziert.

---

## 2. Change-Dokumentation (RFC / Change Record)

### RFC-001 — Initialentwicklung

| Attribut | Wert |
|---|---|
| RFC-ID | RFC-ERECH-001 |
| Typ | Normal Change |
| Priorität | Hoch |
| Kategorie | Neue Anwendung / New Service |
| Datum | 21.05.2026 |
| Commit | `aabc218` |

**Änderungsinhalt:**
Erstmalige Bereitstellung der Webanwendung mit Grundfunktionen:
- XRechnung 3.0 XML-Generator (CII UN/CEFACT)
- ZUGFeRD-Basisfunktionalität (PDF-Embedding)
- Formular zur Dateneingabe

**Rollback:** Löschung der GitHub-Pages-Branch `master`

---

### RFC-002 — Microsoft Entra ID Authentifizierung

| Attribut | Wert |
|---|---|
| RFC-ID | RFC-ERECH-002 |
| Typ | Normal Change |
| Priorität | Hoch |
| Kategorie | Security / Access Management |
| Datum | 21.05.2026 |
| Commit | `f6eb4f3` |

**Änderungsinhalt:**
- MSAL.js (Microsoft Authentication Library) Integration
- Single-Tenant-Auth-Guard gegen DIHAG Azure AD
- Zugriff ausschließlich für authentifizierte DIHAG-Konten

**Rollback:** Commit `aabc218` wiederherstellen (Auth-Guard entfernen)

---

### RFC-003 — SharePoint-Integration & PDF-Parser

| Attribut | Wert |
|---|---|
| RFC-ID | RFC-ERECH-003 |
| Typ | Normal Change |
| Priorität | Mittel |
| Kategorie | Service Enhancement / Integration |
| Datum | 21.05.2026 |
| Commits | `6955773`, `0ea3652`, `cdbe9ce`, `08a1f22`, `72a5e01`, `b76b25b`, `7d6bfef` |

**Änderungsinhalt:**
- `parser.js`: Automatische Rechnungsdatenextraktion aus hochgeladenen PDFs (PDF.js)
- `sharepoint.js`: Archivierung erzeugter XML/PDF-Dateien in Microsoft SharePoint (Graph API)
- SharePoint-Liste „E-Rechnung" als Verlaufsspeicher
- Robuste Parser-Verbesserungen für Firmennamen mit Bindestrichen, USt-IdNr-Varianten, Adressfenster-Erkennung

**Rollback:** `sharepoint.js` und `parser.js` aus `app.js` aushängen

---

### RFC-004 — XRechnung BR-DE-Konformität (Schemavalidierung)

| Attribut | Wert |
|---|---|
| RFC-ID | RFC-ERECH-004 |
| Typ | Normal Change |
| Priorität | Hoch |
| Kategorie | Compliance / Bugfix |
| Datum | 22.05.2026 |
| Commits | `f0e6dc5`, `05d5c29`, `a6fdd91`, `2bf731d` |

**Ausgangslage:** KoSIT-Validierung ergab Verletzungen der XRechnung-Pflichtregeln.

**Behobene Probleme:**

| Regel | Beschreibung | Commit |
|---|---|---|
| BR-DE-5 | BT-41 PersonName (Ansprechpartner) fehlte in BG-6 | `a6fdd91` |
| BR-DE-2 | BG-6 Seller Contact obligatorisch; Telefon oder E-Mail mind. eines | `05d5c29` |
| BR-DE-1 | VA + FC Steuerregistrierungen beide ausgeben | `f0e6dc5` |
| — | Ansprechpartner als UI-Pflichtfeld | `2bf731d` |

**Rollback:** Commits `2bf731d`→`f0e6dc5` revertieren

---

### RFC-005 — ZUGFeRD PDF/A-3-Konformität

| Attribut | Wert |
|---|---|
| RFC-ID | RFC-ERECH-005 |
| Typ | Normal Change |
| Priorität | Hoch |
| Kategorie | Compliance / Bugfix |
| Datum | 22.05.2026 |
| Commits | `a829f38`, `676d074` |

**Ausgangslage:** EU-Rechnung v2.52-Validierung ergab 4 PDF/A-3-Fehler.

**Behobene Probleme:**

| Fehlercode | Beschreibung | Lösung |
|---|---|---|
| FX-SCH-A-000026 | Falsche BT-24 Guideline-ID für ZUGFeRD | Korrigiert auf `urn:cen.eu:en16931:2017` |
| ISO 19005-3 §6.2.4.3 | DeviceRGB ohne OutputIntent (Bilder-Farbraum) | sRGB IEC61966-2-1 ICC-Profil (3144 Byte) als OutputIntent eingebettet |
| XMP-001/002 | pdfaExtension:schemas in separatem rdf:Description | Konsolidierung auf einen einzigen rdf:Description-Block |

**Bekannter Restfehler:** CIDSet-Fehler im Quell-PDF (Schrift-Subset-Tabelle) — liegt im Quell-PDF, nicht in der Anwendung behebbar (siehe Abschnitt 7).

**Rollback:** Commit `676d074` revertieren → `zugferd.js` Vorversion

---

### RFC-006 — PEPPOL-Validierungskonformität

| Attribut | Wert |
|---|---|
| RFC-ID | RFC-ERECH-006 |
| Typ | Normal Change |
| Priorität | Mittel |
| Kategorie | Compliance |
| Datum | 22.05.2026 |
| Commits | `70f8bfa`, `ba3adca`, `8591bc1`, `414f3c1` |

**Ausgangslage:** KoSIT-Validierung nach RFC-004 zeigte verbleibende PEPPOL-Warnungen.

**Behobene Probleme:**

| Regel | Beschreibung | Lösung |
|---|---|---|
| BR-DE-21 | BT-24 Syntax-Kennung veraltet (`xoev-de`-Domain) | Migriert auf `urn:xeinkauf.de:kosit:xrechnung_3.0` |
| PEPPOL-EN16931-R001 | BT-23 BusinessProcess fehlte | `BusinessProcessSpecifiedDocumentContextParameter` hinzugefügt (nur XRechnung) |
| PEPPOL-EN16931-R020 | BT-34 Verkäufer-Endpunkt fehlte | `URIUniversalCommunication schemeID="EM"` aus Verkäufer-E-Mail |
| PEPPOL-EN16931-R010 | BT-49 Käufer-Endpunkt fehlte | `URIUniversalCommunication schemeID="0204"` (Leitweg-ID) oder `"EM"` (E-Mail) |

**Zusätzlich:** Vollständige Pflichtfeldvalidierung im Frontend; dynamische `*`-Toggles für bedingte Pflichtfelder.

---

### RFC-007 — Compliance-Footer & Versionierung

| Attribut | Wert |
|---|---|
| RFC-ID | RFC-ERECH-007 |
| Typ | Standard Change |
| Priorität | Niedrig |
| Kategorie | Compliance / Documentation |
| Datum | 22.05.2026 |
| Commit | `ab59509` |

**Änderungsinhalt:**
- Sichtbarer Haftungsausschluss-Footer mit Norm-Referenzen
- Versionsangabe (XRechnung 3.0 / ZUGFeRD 2.4 / Stand)
- Korrektur Export-Label „ZUGFeRD 2.3" → „2.4"

---

## 3. Service Design — Technische Architektur

### 3.1 Systemarchitektur

```
┌─────────────────────────────────────────────────────────────┐
│                    Browser (Client-only)                    │
│                                                             │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌─────────┐ │
│  │ auth.js  │   │ parser.js│   │xrechnung │   │zugferd  │ │
│  │ MSAL.js  │   │ PDF.js   │   │   .js    │   │   .js   │ │
│  │ Entra ID │   │ PDF→Daten│   │ XML-Gen  │   │PDF+XML  │ │
│  └────┬─────┘   └────┬─────┘   └────┬─────┘   └────┬────┘ │
│       │              │               │               │      │
│  ┌────▼──────────────▼───────────────▼───────────────▼────┐ │
│  │                      app.js                            │ │
│  │          Formular · Validierung · Export               │ │
│  └────────────────────────┬───────────────────────────────┘ │
│                           │                                 │
│  ┌────────────────────────▼───────────────────────────────┐ │
│  │              sharepoint.js (Graph API)                  │ │
│  │       Archivierung XML/PDF → SharePoint-Liste          │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
         │                                      │
         ▼                                      ▼
  Microsoft Entra ID                   Microsoft SharePoint
  (DIHAG Tenant)                       (Liste: E-Rechnung)
```

### 3.2 Keine Server-Komponente

Die Anwendung ist vollständig **client-seitig** (Static Site). Es gibt:
- keinen Anwendungsserver
- keine Datenbank
- keine serverseitige Verarbeitung
- keine API-Endpunkte der Anwendung selbst

Alle Berechnungen, XML-Generierung und PDF-Manipulation erfolgen im Browser des Nutzers.

### 3.3 Externe Abhängigkeiten

| Dienst | Zweck | SLA-Verantwortung |
|---|---|---|
| GitHub Pages | Hosting der statischen Dateien | GitHub (Microsoft) |
| Microsoft Entra ID | Authentifizierung / Auth-Guard | Microsoft / DIHAG IT |
| Microsoft SharePoint | Rechnungsarchiv (optional) | Microsoft / DIHAG IT |
| — | Keine CDN-Abhängigkeiten (alle Libraries lokal) | Entfällt |

---

## 4. Konfigurationselemente (CI / CMDB)

### 4.1 Software-Komponenten

| CI-Name | Typ | Version | Pfad | Beschreibung |
|---|---|---|---|---|
| app.js | Anwendungslogik | 1.2 | `js/app.js` | Haupt-Controller: Formular, Validierung, Export |
| xrechnung.js | Modul | 1.2 | `js/xrechnung.js` | XRechnung 3.0 / ZUGFeRD XML-Generator (CII) |
| zugferd.js | Modul | 1.2 | `js/zugferd.js` | PDF/A-3b-Embedding mit ICC-OutputIntent und XMP |
| parser.js | Modul | 1.1 | `js/parser.js` | PDF-Rechnungsdaten-Extraktion (PDF.js) |
| auth.js | Modul | 1.0 | `js/auth.js` | MSAL.js Entra-ID Auth-Guard |
| sharepoint.js | Modul | 1.1 | `js/sharepoint.js` | SharePoint Graph API Archivierung |
| history.js | Modul | 1.0 | `js/history.js` | LocalStorage Verlaufsverwaltung |
| style.css | Stylesheet | 1.2 | `css/style.css` | UI-Styles |
| index.html | Frontend | 1.2 | `index.html` | Eingabeformular |

### 4.2 Drittanbieter-Bibliotheken (lokal eingebettet)

| Library | Version | Pfad | Lizenz |
|---|---|---|---|
| MSAL.js (msal-browser) | 2.x | `js/vendor/msal-browser.min.js` | MIT |
| PDF.js | — | `js/vendor/pdf.min.js` | Apache 2.0 |
| pdf-lib | 1.17.1 | `js/vendor/pdf-lib.min.js` | MIT |

> Alle Bibliotheken sind lokal eingebettet. Es werden keine externen CDNs geladen, um Edge Tracking Prevention und Datenschutzprobleme zu vermeiden.

### 4.3 Implementierte Standards

| Standard | Version | Anwendung im Code |
|---|---|---|
| EN 16931-1 | 2017 | Semantisches Modell, beide Profile |
| XRechnung CII | 3.0 | `xrechnung.js` → BT-24 `urn:xeinkauf.de:kosit:xrechnung_3.0` |
| ZUGFeRD / Factur-X | 2.4 / 1.08 | `zugferd.js` → BT-24 `urn:cen.eu:en16931:2017` |
| PEPPOL BIS Billing | 3.0 | BT-23 `urn:fdc:peppol.eu:2017:poacc:billing:01:1.0` |
| PDF/A | ISO 19005-3 (PDF/A-3b) | OutputIntent sRGB IEC61966-2-1, XMP-Metadaten |
| UN/CEFACT CII | D16B | XML-Syntax beider Profile |

---

## 5. Release-Dokumentation

### Release 1.0 — 21.05.2026

**Umfang:** Erstveröffentlichung

- XRechnung 3.0 XML-Erzeugung
- ZUGFeRD-Basisfunktion
- Microsoft Entra ID Single-Tenant-Auth
- PDF-Autoerkennung (parser.js)
- SharePoint-Archivierung
- LocalStorage-Verlauf

**Deployment:** `git push origin master` → GitHub Actions → GitHub Pages (automatisch, ca. 2 Min.)

---

### Release 1.1 — 22.05.2026 (Vormittag)

**Umfang:** XRechnung-Schemakonformität + ZUGFeRD PDF/A-3

- BR-DE-2, BR-DE-5 behoben
- PDF/A-3b OutputIntent + XMP konsolidiert
- Ansprechpartner als Pflichtfeld

---

### Release 1.2 — 22.05.2026 (Nachmittag)

**Umfang:** PEPPOL-Konformität + UI-Vervollständigung

- BR-DE-21, PEPPOL-R001/R010/R020 behoben
- Alle Pflichtfelder im Formular gekennzeichnet
- Dynamische Pflichtfeld-Toggles (USt↔StNr, Tel↔E-Mail, Leitweg↔E-Mail)
- Compliance-Footer mit Haftungsausschluss und Versionsangabe

---

## 6. Test & Validierung

### 6.1 Validierungstools

| Tool | Zweck | URL |
|---|---|---|
| KoSIT Prüftool (online) | XRechnung-Schemavalidierung | https://erechnungsvalidator.service-bw.de |
| EU-Rechnung v2.52 | ZUGFeRD / Factur-X Validierung | https://www.e-rechnung-bund.de/validator/ |
| veraPDF | PDF/A-3-Konformitätsprüfung | https://verapdf.org |

### 6.2 Validierungsergebnisse (Stand Release 1.2)

#### XRechnung 3.0 — KoSIT

| Kategorie | Ergebnis |
|---|---|
| Schema-Fehler (errors) | **0** |
| Warnungen (warnings) | **0** |
| Informationen | 0 |
| Geprüfte Regeln | BR-DE-1 bis BR-DE-26, PEPPOL-EN16931-R001 bis R020 |

#### ZUGFeRD 2.4 — EU-Rechnung

| Kategorie | Ergebnis |
|---|---|
| XML-Fehler (FX-SCH) | **0** |
| PDF/A-3-Fehler | **0** ¹ |
| Warnungen | 0 |

¹ *CIDSet-Fehler im Quell-PDF verbleiben, wenn das hochgeladene PDF selbst nicht PDF/A-konform ist (nicht durch die Anwendung verursacht — siehe Abschnitt 7).*

---

## 7. Bekannte Fehler (Known Error Record)

### KE-001 — CIDSet in Quell-PDF

| Attribut | Wert |
|---|---|
| Known-Error-ID | KE-ERECH-001 |
| Status | Offen / Akzeptiert |
| Priorität | Niedrig |
| Entdeckt | 22.05.2026 |

**Fehlerbeschreibung:**  
Wenn das hochgeladene Quell-PDF CIDSet-Fehler in Schrift-Subset-Tabellen enthält (ISO 19005-3 §7.21.3), werden diese Fehler in das ZUGFeRD-Ausgabe-PDF übernommen und erscheinen in der PDF/A-3-Validierung.

**Ursache:**  
Das Quell-PDF wurde nicht PDF/A-konform erzeugt. Die Anwendung bettet das PDF unverändert ein und kann Schrift-Metadaten nicht nachträglich korrigieren, ohne das PDF neu zu rendern.

**Workaround:**  
Quell-PDF vor dem Upload mit einem PDF/A-Konverter (z. B. Adobe Acrobat, ghostscript) in PDF/A-3 konvertieren.

**Lösung:**  
Nicht geplant — liegt außerhalb des Anwendungsbereichs der Software.

---

## 8. Betrieb & Support

### 8.1 Deployment-Prozess

```
Entwicklung (lokal)
       │
       ▼
  git add / commit
       │
       ▼
  git push origin master
       │
       ▼
  GitHub Pages Build (automatisch, ~2 Minuten)
       │
       ▼
  https://dfedorov12.github.io/e-rechnung/
```

Es sind keine Datenbankmigrationen, Rollouts oder Serverneustarts erforderlich. Deployments sind jederzeit möglich.

### 8.2 Rollback-Verfahren

```bash
# Letzten Commit identifizieren
git log --oneline

# Auf Vorgänger-Commit zurücksetzen
git revert <commit-hash>
git push origin master
```

Vollständiger Rollback auf ein bestimmtes Release:
```bash
git checkout <release-tag> -- .
git commit -m "rollback: zurück auf Release X.Y"
git push origin master
```

### 8.3 Monitoring

Da die Anwendung client-seitig ist, gibt es kein Server-Monitoring. Verfügbarkeit wird über den GitHub Pages Status geprüft:
- https://www.githubstatus.com/

### 8.4 Support-Kontakt

| Rolle | Kontakt |
|---|---|
| Entwicklung / 1st Level | Denis Fedorov, DIHAG IT |
| GitHub Repository | https://github.com/dfedorov12/e-rechnung |
| Standard-Updates | https://www.xeinkauf.de (XRechnung) · https://www.ferd-net.de (ZUGFeRD) |

---

## 9. Risikobewertung

| Risiko | Wahrscheinlichkeit | Auswirkung | Maßnahme |
|---|---|---|---|
| Standard-Update (XRechnung / ZUGFeRD neue Version) | Mittel | Hoch | Jährliche Prüfung auf xeinkauf.de / ferd-net.de; Validierung mit KoSIT nach Änderungen |
| GitHub Pages Ausfall | Niedrig | Hoch | Lokale Offline-Nutzung möglich (statische Dateien), Deployment auf alternativer Infrastruktur |
| Microsoft Entra ID Token-Ablauf | Niedrig | Mittel | MSAL.js handhabt Silent-Token-Refresh automatisch |
| SharePoint API Breaking Change | Niedrig | Niedrig | SharePoint-Archivierung ist optional; XML/PDF-Download funktioniert unabhängig |
| Browser-Kompatibilität | Niedrig | Mittel | Getestet in Microsoft Edge (Chromium) und Chrome; IE11 nicht unterstützt |
| Datenverlust LocalStorage | Niedrig | Niedrig | Nur Verlaufsanzeige; Rechnungsdaten sind im XML/PDF enthalten |

---

## Anhang A — Normative Referenzen

| Referenz | Titel |
|---|---|
| EN 16931-1:2017 | Electronic invoicing — Part 1: Semantic data model |
| XRechnung 3.0 | Spezifikation der KoSIT / xeinkauf.de, Stand 2024 |
| ZUGFeRD 2.4 | FeRD-Spezifikation, Dezember 2025 |
| Factur-X 1.08 | FNFE-MPE, Dezember 2025 |
| ISO 19005-3:2012 | PDF/A-3 — Archivierungsformat |
| PEPPOL BIS Billing 3.0 | OpenPEPPOL AISBL |
| RFC 3986 | URI-Syntax (IETF) |
| § 14 UStG | Ausstellung von Rechnungen (deutsches Umsatzsteuergesetz) |
| GoBD 2019 | Grundsätze ordnungsmäßiger Buchführung (BMF) |

---

## Anhang B — Glossar

| Begriff | Erklärung |
|---|---|
| BT | Business Term — einzelnes Datenfeld gemäß EN 16931 |
| BG | Business Group — Gruppe zusammengehöriger BTs |
| BR-DE | Business Rule Deutschland — XRechnung-spezifische Pflichtregeln |
| CII | Cross Industry Invoice — UN/CEFACT XML-Syntax |
| CI | Configuration Item — Konfigurationselement im ITIL-Sinne (CMDB) |
| CMDB | Configuration Management Database |
| FNFE | Forum National de la Facture Électronique (Factur-X Standardgremium) |
| GoBD | Grundsätze ordnungsmäßiger DV-gestützter Buchführung |
| ICC | International Color Consortium (Farbprofil-Standard) |
| KoSIT | Koordinierungsstelle für IT-Standards (XRechnung-Herausgeber) |
| MSAL | Microsoft Authentication Library |
| PDF/A-3 | ISO-Archivformat für PDFs mit eingebetteten Dateien |
| PEPPOL | Pan-European Public Procurement On-Line |
| RFC | Request for Change (ITIL Change Management) |
| sRGB | Standard Red Green Blue — ICC-Farbprofil IEC 61966-2-1 |
| URN | Uniform Resource Name — namensbasierter URI |
| XMP | Extensible Metadata Platform (Adobe) |
| ZUGFeRD | Zentraler User Guide des Forums elektronische Rechnung Deutschland |
