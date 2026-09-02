# Konformitätsprüfung

Prüft die vom Konverter erzeugten E-Rechnungen gegen die **offiziellen** Validatoren:
KoSIT-Validator (XRechnung/EN 16931) und veraPDF (PDF/A-3b für ZUGFeRD).

## 1. Musterdateien erzeugen

Nutzt den **echten** Konverter (`js/xrechnung.js`, `js/xml2pdf.js`, `js/zugferd.js`)
headless und schreibt vier repräsentative Fälle nach `validation/out/`:

| Fall | Inhalt |
|------|--------|
| `wgc_standard_19` | WGC, Inland, 19 % |
| `shb_standard_19` | SHB, Inland, 19 % |
| `wgc_innergemeinschaftlich_K` | WGC → AT, 0 %, Kategorie K (VATEX-EU-IC) |
| `wgc_ausfuhr_CH_G` | WGC → CH, 0 %, Ausfuhr, Kategorie G (VATEX-EU-G) |

Je Fall: `*_xrechnung.xml` (reines XML) und `*_zugferd.pdf` (PDF aus Daten + eingebettetes XML).

```bash
cd api && npm install && cd ..
node validation/generate-samples.js
```

## 2a. Automatisch (empfohlen) — GitHub Actions

`.github/workflows/validate.yml` erzeugt die Muster und prüft sie bei jedem Push
(betrifft `js/xrechnung.js`, `js/xml2pdf.js`, `js/zugferd.js`, `validation/**`) sowie
manuell über **Actions → „E-Rechnung Konformitaet" → Run workflow**. Die Reports
liegen danach als Artefakt „konformitaet-reports" bereit.

> Beim allerersten Lauf ggf. die Tool-Versionen/URLs oben im Workflow bestätigen
> (neuere KoSIT-/veraPDF-Releases).

## 2b. Manuell (lokal)

**KoSIT-Validator (XRechnung-XML)** — braucht Java:
- Validator: <https://github.com/itplr-kosit/validator/releases>
- XRechnung-Konfiguration: <https://github.com/itplr-kosit/validator-configuration-xrechnung/releases>

```bash
java -jar validationtool-1.5.0-standalone.jar \
     -s <config>/scenarios.xml -r <config> \
     -o reports validation/out/*_xrechnung.xml
# reports/*-report.xml öffnen: "accepted" oder "rejected"
```

**veraPDF (PDF/A-3b der ZUGFeRD-PDFs)** — braucht Java:
- <https://verapdf.org/software/>

```bash
verapdf --flavour 3b --format text validation/out/*_zugferd.pdf
# Exit 0 = alle konform, 1 = mind. eine nicht konform
```

**Einfache Alternative: Mustangproject** prüft ZUGFeRD-PDF (XML-Profil **und** PDF/A) in einem:
```bash
java -jar Mustang-CLI-*.jar --action validate --source validation/out/wgc_standard_19_zugferd.pdf
```

## Wichtig

- Diese Prüfung bezieht sich auf die **aus Daten gerenderten** ZUGFeRD-PDFs
  (Modus „PDF aus Rechnungsdaten"). Beim Einbetten eines **Original-PDF** hängt die
  PDF/A-3-Konformität zusätzlich an der Qualität des Quell-PDF.
- Der Konverter bleibt eine Eigenentwicklung und ist **nicht zertifiziert**; diese
  Validierung liefert den objektiven Konformitäts-Nachweis (Pass/Fail je Regel).
