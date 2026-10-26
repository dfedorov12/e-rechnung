# Eingangsrechnungen im Monitoring bearbeiten und genehmigen

Das Monitoring ersetzt die Eingangsrechnungsliste auf
[gruppe_wgc](https://dihag.sharepoint.com/sites/gruppe_wgc/Lists/Eingangsrechnung/AllItems.aspx).
Die Buchhaltung pflegt Varialnummer, Kontierung, Bestellnummer, Bearbeitungsstatus, Genehmigt,
GF gesehen und Notiz direkt an der Rechnung und fordert von dort die Genehmigung an. Die Felder
liegen als Spalten an der Rechnungsdatei in `ERAR_<Werk>`.

Code: `js/bearbeitung.js`, Spalten: `scripts/provision-rechnungsmonitoring.ps1` (`$EingangFelder`)

## Was wohin wandert

| Alte Liste | Im Monitoring | Hinweis |
|---|---|---|
| Title | Rechnungsnummer | aus der Rechnung |
| Varialnummer | Varialnummer | |
| Kontierung | Kontierung | mehrzeilig |
| Bestellnummer | Bestellnummer | bei E-Rechnungen aus der XML vorbelegt |
| Genehmigt | Genehmigt | Werte wie bisher: Ja, Nein, Abgelehnt, In Prüfung, Keine Rechnung, Vertrag, bezahlt, Verkauf, XML |
| Status | Bearbeitungsstatus | Offen, In Genehmigung, Vorkasse&BE-Obligo, Vorkasse erfaßt, Keine RG, Gebucht (m. Prüfg rechn & Stammd), Mahnung, In Klärung, KOPIE |
| Genehmigung an: | Genehmigung an | Mailadresse(n) |
| Genehmigt von | Genehmigt von, Genehmigt am | schreibt der Flow |
| Genehmiger-Kommentare | Genehmigungskommentar | schreibt der Flow |
| GF gesehen | GF gesehen | |
| WL | Info abas gesendet | schreibt der Flow |
| Von | Absender der Rechnungsmail | schreibt der Eingangs-Flow |
| Anlagen | Original, XML, lesbares PDF, KoSIT-Bericht | liegen in `ERAR_WGC` |
| (neu) | Notiz | |
| E-Mail-Inhalt | keine Entsprechung | |

Die 15.704 Einträge der alten Liste werden nicht übernommen. Die Liste bleibt als Archiv
lesbar.

## So funktioniert die Genehmigung

```
Monitoring  „Speichern und Genehmigung anfordern“
  setzt an der Rechnungsdatei: GenehmigungAnfordern = Ja, Genehmigung an, Kommentar,
  Angefordert von/am, Info abas an, Genehmigt = Nein, Bearbeitungsstatus = In Genehmigung
        │
Flow „Genehmigung WGC (Monitoring)“  (Trigger: Datei in ERAR_WGC geändert, nur wenn der Haken gesetzt ist)
  Haken zurücksetzen → Genehmigung mit PDF an den Genehmiger → warten
  Ja:   Genehmigt = Ja, Genehmigt von/am, Kommentar; bei „Info abas an“ Mail mit PDF dorthin
  Nein: Genehmigt = Abgelehnt, Genehmigt von/am, Kommentar; Mail an den, der angefordert hat
```

Das macht dasselbe wie der bisherige Flow „Genehmigung WGC“. Neu ist, dass die Adresse für
die Info zum Austragen im abas wählbar ist. Vorbelegt ist sie mit der Vorgabe des Werks aus
`Monitoring/monitoring-einstellungen.json` auf der Monitoring-Site (für WGC Hr. Lang). Im Dialog
lässt sich die Vorgabe nicht mehr ändern, eine andere Adresse gilt nur für diese Rechnung.

Geschrieben wird an eine Datei je Rechnung: das Original-PDF, bei einer XRechnung das
lesbare PDF. Diese Datei bekommt der Genehmiger als Anhang.

---

## Umstellung Schritt für Schritt

### Schritt 1: Spalten anlegen

```powershell
cd scripts
.\provision-rechnungsmonitoring.ps1 -SiteUrl https://dihag.sharepoint.com/sites/Rechnungsmonitoring -ClientId df9691fc-bed8-4134-820e-99654640eb0e -Werke WGC,SHB,ZAI -WhatIfOnly
```

Ausgabe prüfen, dann ohne `-WhatIfOnly` ausführen. Unter „Bearbeitung (Buchhaltung)“ kommen je
`ERAR_<Werk>` 16 neue Spalten dazu. `-Werke` auf die Werke setzen, die es schon gibt.

### Schritt 2: Rechte

Die Buchhaltung WGC braucht auf `ERAR_WGC` das Recht **Mitwirken**, sonst meldet der Dialog
„Keine Schreibrechte“. Mitwirken erlaubt auch das Löschen von Dateien. Das Aufbewahrungslabel
(Datensatz) verhindert das bei gelabelten Dateien. Wer sichergehen will, legt eine
Berechtigungsstufe „Mitwirken ohne Löschen“ an.

### Schritt 3: Aufbewahrungslabel prüfen

Das GoBD-Label ist als Datensatz angelegt (siehe [GoBD-Aufbewahrung.md](GoBD-Aufbewahrung.md)).
Datensätze sperren den Inhalt, die Eigenschaften lassen sich normalerweise weiter ändern. Einmal
im Monitoring an einer gelabelten Rechnung die Varialnummer speichern. Meldet der Dialog „Die
Aufbewahrungsbezeichnung der Datei erlaubt keine Änderung der Eigenschaften“, in Microsoft
Purview unter Records Management, Einstellungen, das Bearbeiten der Eigenschaften von
Datensätzen zulassen.

### Schritt 4: Flow „Genehmigung WGC (Monitoring)“ anlegen

https://make.powerautomate.com, „Erstellen“, **„Automatisierter Cloud-Flow“**.

1. **Trigger** SharePoint **„Wenn eine Datei erstellt oder geändert wird (nur Eigenschaften)“**
   - Websiteadresse: `https://dihag.sharepoint.com/sites/Rechnungsmonitoring`
   - Bibliotheksname: `ERAR_WGC`
   - Reiter „Einstellungen“, Auslöserbedingung:
     ```
     @equals(triggerOutputs()?['body/GenehmigungAnfordern'], true)
     ```
   - „„Teilen bei“-Nachverfolgungs-ID“: `@{triggerBody()?['ID']}` (darf nicht leer sein)

   Der Flow startet nur, wenn im Monitoring „Genehmigung anfordern“ gespeichert wurde. Alle
   anderen Änderungen an der Datei lösen nichts aus.

2. SharePoint **„Dateieigenschaften aktualisieren“**, umbenennen in `Anforderung quittieren`
   - Website, Bibliothek wie im Trigger, ID: **ID** aus dem Trigger
   - „Genehmigung anfordern (Ausloeser)“: **Nein**

   Muss der erste Schritt sein. Danach löst die Datei den Flow nicht noch einmal aus.

3. SharePoint **„Dateiinhalt abrufen“**, umbenennen in `PDF`
   - Website wie oben, Dateibezeichner: **Bezeichner** aus dem Trigger

4. Genehmigungen **„Genehmigung starten und darauf warten“**, umbenennen in `Genehmigung`
   - Genehmigungstyp: „Genehmigen/Ablehnen – Erste Antwort“
   - Titel: `Eingangsrechnung ` + **Rechnungsnummer** + ` ` + **Rechnungssteller**
   - Zugewiesen an: **Genehmigung an**
   - Details:
     ```
     Kommentar: [Kommentar zur Anforderung]
     Varialnummer: [Varialnummer]
     Kontierung: [Kontierung]
     Bestellnummer: [Bestellnummer]
     Betrag: [Bruttobetrag] [Waehrung]
     ```
     (die Werte in Klammern jeweils als dynamischen Inhalt aus dem Trigger einsetzen)
   - Link zum Element: **Link zum Element**, Beschreibung: `Rechnung öffnen`
   - Angefordert von (erweiterte Parameter, optional): **Genehmigung angefordert von**
   - Anlagen: Name = **Dateiname mit Erweiterung** (Trigger), Inhalt = **Dateiinhalt** (aus `PDF`)

5. **Bedingung**: links über „fx“ `outputs('Genehmigung')?['body/outcome']`, „ist gleich“,
   rechts `Approve`.

6. Zweig **„Wahr“** (genehmigt):
   1. „Dateieigenschaften aktualisieren“, umbenennen in `Genehmigt`. ID aus dem Trigger.
      - Genehmigt: **Ja**
      - Genehmigt von, über „fx“:
        ```
        first(outputs('Genehmigung')?['body/responses'])?['responder']?['displayName']
        ```
      - Genehmigt am: `utcNow()`
      - Genehmigungskommentar:
        ```
        first(outputs('Genehmigung')?['body/responses'])?['comments']
        ```
   2. **Bedingung**: links `empty(triggerOutputs()?['body/AbasInfoAn'])`, „ist gleich“, rechts
      `false`. Im Zweig „Wahr“:
      - Office 365 Outlook **„E-Mail senden (V2)“**
        - An: **Info zum Austragen im abas an**
        - Betreff: **Rechnungsnummer** ` || ` **Varialnummer** ` wurde genehmigt`
        - Text: wer genehmigt hat, Kommentar, Kontierung, Bestellnummer und der Link zur Rechnung
        - Anlagen: Name = **Dateiname mit Erweiterung**, Inhalt = **Dateiinhalt** (aus `PDF`)
      - darunter „Dateieigenschaften aktualisieren“: „Info abas gesendet (WL)“ = **Ja**

7. Zweig **„Falsch“** (abgelehnt):
   1. „Dateieigenschaften aktualisieren“, umbenennen in `Abgelehnt`: Genehmigt = **Abgelehnt**,
      Genehmigt von, Genehmigt am und Genehmigungskommentar wie in 6.1.
   2. **Bedingung**: `empty(triggerOutputs()?['body/AngefordertVon'])` ist gleich `false`. Im
      Zweig „Wahr“: **„E-Mail senden (V2)“** an **Genehmigung angefordert von**, Betreff
      `Eingangsrechnung ` + **Rechnungsnummer** + ` abgelehnt`, im Text wer abgelehnt hat, der
      Kommentar und der Link.

8. Speichern.

Für ein weiteres Werk den Flow kopieren („Speichern unter“) und im Trigger die Bibliothek
ändern, zum Beispiel `ERAR_ZAI`.

### Schritt 5: Testen

1. Im Monitoring bei einer WGC-Rechnung „Bearbeiten“, Varialnummer und Kontierung eintragen,
   „Speichern“. Die Varialnummer steht danach unter der Rechnungsnummer.
2. Wieder „Bearbeiten“, „Genehmigung anfordern“ anhaken, als Genehmiger die **eigene** Adresse,
   Haken bei der abas-Info mit der eigenen Adresse, „Speichern und Genehmigung anfordern“.
3. An der Rechnung steht „In Genehmigung“. Nach wenigen Minuten kommt die Genehmigung
   in Teams bzw. per Mail, mit dem PDF.
4. Genehmigen. Nach dem Neuladen steht „Genehmigt“, im Dialog „Genehmigt von … am …“, und die
   abas-Info ist im Postfach.
5. Dasselbe mit Ablehnen: „Abgelehnt“ mit Kommentar, Mail an den Anfordernden.

### Schritt 6: Umschalten

1. Im Eingangs-Flow `E-R-Rechnung_WGC` die Schritte entfernen, die den Eintrag in der
   Eingangsrechnungsliste auf gruppe_wgc anlegen, die Anlagen hinzufügen und den Eintrag
   aktualisieren. Die Ablage in `ERAR_WGC` bleibt.
2. Die Buchhaltung arbeitet ab dem Stichtag nur noch im Monitoring.
3. Den alten Flow „Genehmigung WGC“ laufen lassen, bis die offenen Genehmigungen aus der alten
   Liste durch sind, dann ausschalten.
4. Die alte Liste auf „Lesen“ stellen.

---

## Ablauf in der Buchhaltung

1. Im Monitoring die Rechnung suchen. Die Suche findet auch Varialnummer, Kontierung,
   Bestellnummer und Notiz.
2. „Bearbeiten“ in der letzten Spalte. Varialnummer, Bestellnummer, Bearbeitungsstatus,
   Kontierung, Genehmigt, GF gesehen und Notiz eintragen, „Speichern“.
3. Genehmigung: „Genehmigung anfordern“ anhaken, Genehmiger eintragen (mehrere mit `;`, dann
   gilt die erste Antwort), Kommentar, bei Bedarf die Info zum Austragen im abas, „Speichern
   und Genehmigung anfordern“.
   - Beim Tippen von Name oder Mail schlägt das Feld Personen vor: zuletzt verwendete,
     Genehmiger aus dem Monitoring und, mit Freigabe, das Firmenverzeichnis. Pfeiltasten und
     Enter wählen aus.
   - Die abas-Adresse ist mit der Vorgabe des Werks vorbelegt. Eine andere Adresse gilt nur
     für diese Rechnung, taucht aber bei den zuletzt verwendeten Vorschlägen wieder auf.
4. Die Kachel **„In Genehmigung“** zeigt alle offenen Genehmigungen. Die Filter
   „Bearbeitung“ und „Genehmigt“ ersetzen die Ansichten der alten Liste.

Läuft schon eine Genehmigung, fragt der Dialog vor einer neuen nach. Steht an einer Rechnung
länger als einige Minuten „Angefordert bei …, wartet auf den Flow“, läuft der Flow für dieses
Werk nicht. Dann die IT informieren.

## Personen aus dem Firmenverzeichnis vorschlagen

Für die Suche nach Name oder Mail braucht die App „DIHAG-E-Rechnung“ das delegierte Recht
**User.ReadBasic.All** (Name, Mail, Anmeldename, sonst nichts). Bis es freigegeben ist,
zeigt das Feld nur bekannte und zuletzt verwendete Personen und den Knopf „Im
Firmenverzeichnis suchen“. Der fragt per Popup nach der Zustimmung, sofern Benutzer im
Mandanten selbst zustimmen dürfen.

Einmal für alle freigeben (Admin):
1. Microsoft Entra Admin Center, „App-Registrierungen“, **DIHAG-E-Rechnung**
   (Anwendungs-ID `50389599-4d5d-4267-8fef-38ff29080669`).
2. „API-Berechtigungen“, „Berechtigung hinzufügen“, Microsoft Graph, „Delegierte
   Berechtigungen“, **User.ReadBasic.All**, „Berechtigungen hinzufügen“.
3. **„Administratorzustimmung für DIHAG erteilen“** und bestätigen.

## Spalten und Bearbeiten je Werk

Der Knopf **„Spalten“** neben „Zurücksetzen“ ist nur für Admins sichtbar
(`administrator@dihag.com`, js/access.js). Dort wird je Werk festgelegt:
- **Bearbeiten-Funktion** an oder aus. Aus heißt kein „Bearbeiten“-Knopf, keine Spalten
  Varialnummer, Kontierung, Bearbeitung, Genehmigung und Notiz. Das passt für Werke, die über
  SAP buchen und nie mit der Eingangsrechnungsliste gearbeitet haben, zum Beispiel ZAI.
- **Welche Spalten** das Werk zeigt und **in welcher Reihenfolge** (Ziehen am ☰ oder Pfeile).
  „Bearbeiten“ mit den Dateien ist immer dabei und steht im Standard vorn. Auswahl aus: Datum, Werk, Richtung, Rechnungsnr., Steller /
  Empfänger, Netto, Brutto, Fällig am, Klassifizierung, Status, Buchung, Lieferant informiert,
  Konform., Fehler, Bestellnummer, Varialnummer, Kontierung, Bearbeitung, Genehmigung, Notiz.
  „Standard“ setzt die Auswahl zurück (Netto statt Brutto, mit Lieferant informiert und den
  Spalten der Bearbeitung).

Unter **„Speichern für“** gilt die Einstellung nur für das gewählte Werk oder für alle Werke
auf einmal. Mit **„Meine Spaltenbreiten als Standard für alle übernehmen“** werden die
Breiten, die der Admin im Kopf gezogen hat, zum Standard für alle Benutzer. Wer selbst
zieht, behält seine eigenen Breiten.

Ist im Filter ein Werk gewählt, zeigt die Tabelle genau dessen Spalten in dessen
Reihenfolge. Ohne Werkfilter zeigt sie die Spalten aller Werke zusammen, in der Reihenfolge
des Werks mit den meisten Rechnungen. Zellen eines Werks ohne die Spalte bleiben leer. Die
Auswahl gilt für alle, die das Monitoring nutzen, und liegt in
`Monitoring/monitoring-einstellungen.json` auf der Monitoring-Site.

Unter „Alle Buchung“ gibt es zusätzlich **„Kleinbetrag (bis 250 € brutto)“**. Der Filter
findet nur Rechnungen, deren Bruttobetrag bekannt ist, bei PDF-Rechnungen ohne XML fehlt er
meist.

## Hinweise

- „GF gesehen“ steht in der alten Liste bei 98 % der Einträge auf Ja, vermutlich als
  Standardwert. Im Monitoring gibt es keinen Standard, der Haken wird bewusst gesetzt.
- Eine Genehmigung wartet höchstens 30 Tage, so lange darf ein Flow laufen. Danach steht die
  Rechnung weiter auf „In Genehmigung“ und muss neu angefordert werden.
- Ausgangsrechnungen und Rechnungen, die noch keinem Werk zugeordnet sind, haben keinen
  „Bearbeiten“-Knopf.
