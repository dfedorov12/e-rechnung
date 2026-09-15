# Verfahrensdokumentation — E‑Rechnungs‑Tool DIHAG (Unternehmensgruppe 2)

> **Status: Entwurf v0.1** — fachlich/technisch aus dem System abgeleitet. Frist,
> Record‑Deklaration und diese Verfahrensdokumentation sind vom Steuerberater / der
> Wirtschaftsprüfung abzunehmen (vgl. PwC‑Memo v. 10.09.2026, Abschnitt C).
>
> Rechtsgrundlagen: GoBD (BMF 28.11.2019) inkl. Änderungsschreiben 14.07.2025;
> §§ 14, 14a, 14b, 14c UStG; § 147 AO; UStAE‑Anpassung BMF 15.10.2025; EN 16931.

**Geltungsbereich:** E‑Rechnungs‑Tool der DIHAG‑IT für **Unternehmensgruppe 2**
(SCH, MEG, SHB, WGC). Das Tool wird technisch für weitere Gesellschaften bereitgestellt;
diese Dokumentation beschreibt den Einsatz in Gruppe 2. Sie ist selbst
versionsgeführt (Git‑Repository `dfedorov12/e-rechnung`) — Änderungshistorie s. u.

---

## 1. Allgemeine Beschreibung

Das Tool verarbeitet elektronische Rechnungen nach EN 16931:

- **Eingang:** eingehende XRechnung‑ bzw. ZUGFeRD‑Rechnungen werden **vor** der
  ERP‑Erfassung eingelesen, klassifiziert, gegen KoSIT/EN 16931 (und die PDF/A‑Hülle
  gegen veraPDF) validiert, in eine **lesbare PDF‑Darstellung** überführt und samt
  Original‑XML revisionssicher archiviert. Die Buchung erfolgt anschließend durch
  Sichtprüfung und **manuelle Erfassung** im ERP.
- **Ausgang:** das ERP‑System erzeugt zunächst eine PDF‑Rechnung; diese wird an das
  Tool übergeben, das daraus eine E‑Rechnung (ZUGFeRD/XRechnung) generiert, automatisch
  nach KoSIT/EN 16931 validiert und die XML‑Datei in SharePoint/Purview archiviert.

Maßgeblich für den Vorsteuerabzug bzw. den Rechnungsinhalt ist stets der **strukturierte
Teil (XML)**; die PDF‑Darstellung ist unverbindliche Visualisierung.

**Zweck der Dokumentation:** Nachvollziehbarkeit und Nachprüfbarkeit des DV‑Verfahrens
i. S. d. GoBD Rz. 151 (Inhalt, Aufbau, Ablauf, Ergebnisse).

---

## 2. Anwenderdokumentation (Ablauf)

### 2.1 Eingangsprozess (Tool vor ERP)
1. Eingang je Werk über eine **eigene E‑Mail‑Adresse** (Shared Mailbox) → die
   Werkszuordnung steht bereits durch das Postfach fest.
2. Ein Power‑Automate‑Flow übergibt jede Anlage an **`POST /api/intake?werk=<Werk>`**.
   Das Tool: klassifiziert (`zugferd` | `xrechnung-xml` | `pdf-ohne-xml`), validiert
   (KoSIT + veraPDF), erzeugt bei reiner XML ein lesbares PDF/A, prüft den Empfänger
   gegen das Postfach‑Werk (`werkMismatch`) und liefert die Kopfdaten.
3. Ablage in **`ERAR_<Werk>`**: Original + XML + lesbares PDF + KoSIT‑Bericht mit
   gesetzten Metadaten. Dateiname = **`<Nummer>_<StellerVat>`** (dublettensicher).
4. **Buchung:** Sachbearbeiter prüft die lesbare Darstellung per Sicht, gleicht mit
   Referenzunterlagen ab (Bestellung/Lieferschein) und erfasst **manuell** im ERP.
   Zum Buchungszeitpunkt wird die archivierte XML über die **Belegnummer**
   referenziert (der ERP‑Buchungsbeleg entsteht erst hier — s. 5.3).
5. **Normales PDF ohne E‑Rechnung:** wird gekennzeichnet und archiviert, aber nicht
   automatisch konvertiert.

### 2.2 Ausgangsprozess (Tool nach ERP)
1. Das **ERP** erzeugt die PDF‑Rechnung und übergibt sie automatisiert an das Tool.
2. Das Tool konvertiert nach **XRechnung 3.0 / ZUGFeRD 2.4** (EN 16931), validiert
   automatisch (KoSIT + veraPDF) und protokolliert den Prüfpfad (s. 5.2).
3. **Optional/qualifiziert:** USt‑IdNr. des Empfängers wird über **`/api/vat`**
   (BZSt eVatR + EU‑VIES) qualifiziert bestätigt; der Bericht wird mitgeführt.
4. Ablage in **`AR_<Werk>`**: XML (führend) und – zusätzlich – die PDF‑Darstellung;
   Dateiname `<Nummer>_<Datum>`. Die **Belegnummer** ist die ERP‑Nummer.

---

## 3. Technische Systemdokumentation

| Baustein | Beschreibung |
|----------|--------------|
| Frontend | Browser‑SPA (GitHub Pages, ohne externe CDN‑Abhängigkeiten), MSAL‑Login gegen Entra ID, Microsoft Graph für SharePoint |
| API | Azure Functions (`api/`): `convert`, `validate`, `intake`, `vat` — Key‑geschützt (`?code=`), `vat` anonym (BZSt/VIES offen) |
| Validierung | **KoSIT‑Validator** (Daemon‑Container, `KOSIT_DAEMON_URL`) für Format/Geschäftsregeln; **veraPDF** (`VERAPDF_URL`) für die PDF/A‑3b‑Hülle |
| Formate | XRechnung 3.0 (`urn:xeinkauf.de:kosit:xrechnung_3.0`); ZUGFeRD 2.4 / Factur‑X 1.08, **GuidelineID `urn:cen.eu:en16931:2017`** (EN 16931 / COMFORT) |
| Archiv | SharePoint‑Site *Rechnungsmonitoring*, Bibliotheken `ERAR_<Werk>` / `AR_<Werk>` (+ optional `Rechnungseingang`); **Purview‑Aufbewahrung** (s. 4) |
| Monitoring | Dashboard `monitoring.html` (KPIs, KoSIT‑Klartext‑Hinweis, Dubletten, GoBD‑Abdeckung) — s. `Rechnungsmonitoring.md` |
| Provisionierung | `scripts/provision-rechnungsmonitoring.ps1` (Bibliotheken, Spalten, `Created`‑Index) |

**Schnittstellen:** E‑Mail‑Postfach → `/api/intake` → SharePoint (Eingang);
ERP → Tool (`/api/convert`) → SharePoint (Ausgang); SharePoint ↔ Purview
(Aufbewahrung); Frontend ↔ Graph. Formatprofil **MINIMUM/BASIC‑WL wird nicht
erzeugt** und im Eingang aktiv als „keine vollständige E‑Rechnung" gekennzeichnet.

---

## 4. Betriebsdokumentation — Archivierung (GoBD)

- **Aufbewahrungslabel** „GoBD Rechnungen 8 Jahre" (Microsoft Purview):
  8 Jahre ab Ablage, als **Datensatz/Record** (unveränderbar), Aktion nach Ablauf:
  keine Auto‑Löschung.
- **Standard‑Aufbewahrungslabel** aller Bibliotheken `ERAR_*`/`AR_*` → jede neue Datei
  wird automatisch erfasst.
- **Preservation Lock** auf die Aufbewahrungsrichtlinie → Frist/Umfang auch durch
  Administratoren nicht mehr verkürzbar (Revisionssicherheit).
- Aufbewahrt wird der **strukturierte Teil (XML)** unversehrt in Ursprungsform;
  zusätzlich wird die **PDF‑Darstellung** archiviert (Empfehlung des Memos; deckt
  Buchungsvermerke/abweichende Bildteile ab).
- **Nachweis:** Das Monitoring zeigt die Abdeckung („GoBD‑archiviert N/Gesamt" + Badge
  je Zeile) aus dem tatsächlichen `_ComplianceTag`. Details: `GoBD-Aufbewahrung.md`.

> Bestätigt eingerichtet (Stand der Freigabe durch die IT): Label 8 J. / Record /
> Preservation Lock / Standardlabel auf allen Bibliotheken.

---

## 5. Internes Kontrollverfahren (IKV) — Prüfpfad

Da DIHAG **weder QES noch EDI** einsetzt, trägt das IKV die Nachweislast für Echtheit
und Unversehrtheit allein (§ 14 Abs. 3 UStG). 

### 5.1 Eingang
- **Sichtprüfung** der lesbaren Darstellung und **Abgleich mit Referenzunterlagen**
  (Bestellung, Auftrag, Lieferschein, Zahlungsbeleg) vor der Buchung.
- Technische Validierung (KoSIT/EN 16931 + veraPDF); der **KoSIT‑Prüfbericht** wird je
  Rechnung archiviert. Nicht‑konforme Eingänge werden im Monitoring rot mit
  Klartext‑Grund ausgewiesen.
- Für den Vorsteuerabzug ist ausschließlich die **XML** maßgeblich; Visualisierungs‑
  fehler des Tools sind insoweit unschädlich.

### 5.2 Ausgang (§ 14c‑Absicherung)
- Die XML wird **aus dem ERP‑PDF erzeugt** → inhaltliche Abweichungen können nur aus
  Parsing‑Fehlern oder **manuellen Eingriffen** entstehen. Manuelle Änderungen,
  Quell‑PDF‑Hash und Prüfer werden protokolliert (`ManuelleAenderungen`,
  `QuellPdfHash`, `GeprueftVon`, `Pruefstatus`).
- **Automatische Validierung** (KoSIT/EN 16931): Der Aussteller kann sich auf das
  Format‑/Geschäftsregel‑Ergebnis verlassen; der Validierungsbericht wird aufbewahrt.
- **Materielle Richtigkeit** (z. B. korrekter Steuersatz) wird durch **inhaltliche
  Stichprobenkontrolle** ergänzt — Validierung ersetzt sie nicht.
- Die vom Tool erzeugte PDF ist als **unverbindliche Visualisierung** zu behandeln
  (führend ist die XML), um ein isoliertes § 14c‑Risiko auszuschließen.

### 5.3 Beleg‑Zuordnung (XML ↔ ERP‑Buchungsbeleg)
- Zuordnungsmerkmal ist die **Belegnummer** (nicht das Buchungsdatum — laut GoBD
  Rz. 73 typischerweise ungeeignet).
- **Eingang:** eindeutiger Schlüssel **Rechnungsnummer + Aussteller‑USt‑IdNr.**
  (`dateibasis`), da eine Rechnungsnummer nur je Aussteller eindeutig ist. Die
  Rückverknüpfung zum ERP‑Buchungsbeleg erfolgt bei der manuellen Buchung.
- **Ausgang:** Belegnummer = ERP‑Nummer; Trennung je Werk über `AR_<Werk>`.
- **Zu bestätigen (organisatorisch):** Kollisionsfreiheit der ERP‑Belegnummernkreise
  über die gemeinsam genutzten Gesellschaften.

---

## 6. Abdeckung der Memo‑Punkte (PwC 10.09.2026)

| Memo | Umsetzung |
|------|-----------|
| 1. ZUGFeRD‑Profil (nicht MINIMUM/BASIC‑WL) | ✅ Ausgang = EN 16931 (`urn:cen.eu:en16931:2017`); Eingang erkennt/kennzeichnet MINIMUM/BASIC‑WL |
| 2. Reproduzierbarkeit | PDF wird zusätzlich archiviert; Renderer versionsgeführt (Git) — s. 3/4 |
| 3. Kontrollverfahren dokumentiert | Abschnitt 5 (IKV, Prüfpfad, Audit‑Protokoll) |
| 4. Verfahrensdokumentation | **dieses Dokument** |
| 5. Beleg‑Zuordnung / Nummernkreise | Abschnitt 5.3 (Belegnummer; Kollisionsfreiheit org. zu bestätigen) |
| Validierungsberichte aufbewahren | ✅ KoSIT‑Bericht + veraPDF je Rechnung |
| PDF als unverbindliche Visualisierung | Abschnitt 5.2 (organisatorisch/kennzeichnen) |

---

## 7. Änderungshistorie

| Version | Datum | Autor | Änderung |
|---------|-------|-------|----------|
| 0.1 | 2026‑09‑15 | DIHAG IT | Erstentwurf, aus System abgeleitet; zur WP/StB‑Abnahme |
