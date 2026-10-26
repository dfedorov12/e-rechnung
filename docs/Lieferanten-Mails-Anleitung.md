# Mails an Lieferanten: Anleitung Schritt für Schritt

Schickt ein Lieferant eine Rechnung als reines PDF, schätzt die Buchhaltung im Monitoring ein,
ob er über oder bis 800.000 € Umsatz liegt (§ 27 Abs. 38 UStG). Dazu gibt es die passende
Mailvorlage, und mit **„Speichern und senden“** geht die Mail aus dem Rechnungspostfach des
Werks an den Lieferanten.

- **Teil A** wird einmal eingerichtet (IT, Power Automate, Exchange).
- **Teil B** ist der Ablauf in der Buchhaltung bei jeder PDF-Rechnung.

Solange Teil A nicht fertig ist, öffnet der Dialog die Mail in Outlook. Teil B funktioniert
also schon vorher, nur ohne Versand aus dem Werks-Postfach.

Technischer Hintergrund: [Kreditor-Mail-Flow.md](Kreditor-Mail-Flow.md)

---

## Teil A: Einmal einrichten

### Schritt 1: Spalte und Liste anlegen

Das Skript legt in allen Rechnungsbibliotheken die Spalte „Absender der Rechnungsmail“ an und
dazu die Liste **KreditorMails**, in die das Monitoring die Mailaufträge schreibt.

1. PowerShell öffnen und in den Ordner `scripts` des Repos wechseln. Das Modul
   PnP.PowerShell muss installiert sein (siehe Kopf des Skripts).
2. Zuerst einen Testlauf machen, der nichts ändert:
   ```powershell
   .\provision-rechnungsmonitoring.ps1 -SiteUrl https://dihag.sharepoint.com/sites/Rechnungsmonitoring -ClientId df9691fc-bed8-4134-820e-99654640eb0e -WhatIfOnly
   ```
3. Die Ausgabe ansehen. Ohne `-Werke` nimmt das Skript alle zehn Werke. Steht bei
   Bibliotheken „(wuerde angelegt) [WhatIf]“, die es noch nicht geben soll, den Lauf mit `-Werke` auf
   die vorhandenen Werke beschränken, zum Beispiel `-Werke WGC,SHB,ZAI`.
4. Den Befehl ohne `-WhatIfOnly` ausführen und im Browser anmelden.
5. Erwartete Ausgabe: je Bibliothek `+ AbsenderMail (Text)`, danach
   „Liste angelegt (Versionierung an)“ und die Spalten der Liste KreditorMails.

### Schritt 2: Rechte auf die Liste KreditorMails

Wer in KreditorMails einen Eintrag anlegen darf, kann über den Flow aus dem Werks-Postfach
senden. Deshalb bekommt nur die Buchhaltung Schreibrechte.

1. https://dihag.sharepoint.com/sites/Rechnungsmonitoring öffnen, links „Websiteinhalte“,
   dann **KreditorMails**.
2. Zahnrad oben rechts, „Listeneinstellungen“, „Berechtigungen für diese Liste“.
3. „Berechtigungsvererbung beenden“ und bestätigen.
4. Alle Gruppen außer den Besitzern markieren, „Benutzerberechtigungen bearbeiten“, auf
   **Lesen** setzen. Lesen brauchen alle, die im Monitoring die Abzeichen „Mail gesendet“
   sehen sollen.
5. „Berechtigungen erteilen“: die Buchhaltung und das Konto, mit dem der neue Flow läuft
   (Schritt 5), bekommen **Mitwirken**. Häkchen „E-Mail-Einladung senden“ entfernen.

### Schritt 3: „Senden als“ auf die Werks-Postfächer

Der Flow sendet mit dem Konto, dem die Outlook-Verbindung im Flow gehört. Dieses Konto braucht
auf jedem Werks-Postfach das Recht „Senden als“. Am einfachsten ist das Konto, unter dem schon
die Eingangs-Flows laufen.

1. Exchange Admin Center öffnen: https://admin.exchange.microsoft.com
2. „Empfänger“, „Postfächer“, das Postfach **er-zaigler@dihag.com** anklicken.
3. Reiter „Delegierung“, bei „Senden als“ auf „Bearbeiten“, „Mitglieder hinzufügen“, das
   Flow-Konto auswählen, speichern.
4. Dasselbe für das Rechnungspostfach WGC.
5. Bis das Recht greift, kann es bis zu einer Stunde dauern.

### Schritt 4: Absender in den Eingangs-Flows mitschreiben

Damit der Dialog die Adresse des Lieferanten vorbelegt, schreiben die Eingangs-Flows den
Absender der Rechnungsmail mit. Für jeden Eingangs-Flow (ZAI: „E-R-Rechnung_ZAI“, dazu der
WGC-Flow):

1. https://make.powerautomate.com, „Meine Flows“, den Flow öffnen, „Bearbeiten“.
2. In der Schleife über die Anlagen die Aktion **„Dateieigenschaften aktualisieren“** öffnen.
   Das ist der Schritt, der die Spalten in `ERAR_<Werk>` füllt.
3. „Erweiterte Parameter“ aufklappen und **„Absender der Rechnungsmail“** dazunehmen. Fehlt das
   Feld in der Liste, den Flow einmal schließen und neu öffnen, damit die neue Spalte geladen
   wird.
4. In das Feld klicken, „fx“ (Ausdruck) wählen, eintragen und „Hinzufügen“:
   ```
   triggerOutputs()?['body/from']
   ```
5. „Speichern“.

Rechnungen, die vorher eingegangen sind, haben keinen Absender. Dort trägt die Buchhaltung die
Adresse im Dialog selbst ein.

### Schritt 5: Flow „Kreditor-Mail senden“ anlegen

Ein Flow für alle Werke. Er nimmt jeden neuen Eintrag in KreditorMails, sendet die Mail aus dem
Postfach des Werks und setzt den Status.

1. https://make.powerautomate.com, „Erstellen“, **„Automatisierter Cloud-Flow“**.
   - Name: `Kreditor-Mail senden`
   - Trigger suchen: SharePoint **„Wenn ein Element erstellt wird“**, dann „Erstellen“.

2. **Trigger** einstellen:
   - Websiteadresse: `https://dihag.sharepoint.com/sites/Rechnungsmonitoring`
   - Listenname: `KreditorMails`
   - Reiter „Einstellungen“, bei „Auslöserbedingungen“ auf „Hinzufügen“ und eintragen:
     ```
     @equals(triggerOutputs()?['body/Status/Value'], 'Wartet')
     ```
   - Im selben Reiter „Teilen bei“ eingeschaltet lassen. Das Feld
     **„„Teilen bei“-Nachverfolgungs-ID“** darf nicht leer sein, sonst lässt sich der Flow nicht
     speichern („The 'clientTrackingId' value is not valid“). Eintragen:
     ```
     @{triggerBody()?['ID']}
     ```
     Dann steht im Ausführungsverlauf die ID des Listeneintrags.

3. Darunter **„+“**, Aktion **„Verfassen“** (Datenvorgang). Über „…“ umbenennen in
   `Postfach`. Bei „Eingaben“ über „fx“ diesen Ausdruck eintragen:
   ```
   if(equals(triggerOutputs()?['body/Werk'],'ZAI'),'er-zaigler@dihag.com',if(equals(triggerOutputs()?['body/Werk'],'WGC'),'<Rechnungspostfach WGC>',''))
   ```
   `<Rechnungspostfach WGC>` durch die echte Adresse ersetzen. Kommt ein Werk dazu, hier eine
   weitere Stufe einbauen.

4. Darunter **„+“**, Aktion **„Bedingung“**:
   - linker Wert über „fx“: `empty(outputs('Postfach'))`
   - Operator: „ist gleich“
   - rechter Wert über „fx“: `true`

5. Im Zweig **„Wahr“** (im alten Designer „Wenn ja“, Werk ohne Postfach): SharePoint **„Element aktualisieren“**
   - Websiteadresse und Listenname wie im Trigger
   - ID: dynamischer Inhalt **ID** aus dem Trigger
   - Betreff: dynamischer Inhalt **Betreff** aus dem Trigger (Pflichtfeld)
   - Erweiterte Parameter: Status Value = `Fehler`, Fehlermeldung =
     `Für dieses Werk ist im Flow kein Postfach hinterlegt.`

6. Im Zweig **„Falsch“** („Wenn nein“): Office 365 Outlook
   **„E-Mail aus einem freigegebenen Postfach senden (V2)“**. Über „…“ umbenennen in
   `E-Mail senden` (genau so, der Fehlerschritt unten bezieht sich auf diesen Namen).
   - Ursprüngliche Postfachadresse: dynamischer Inhalt **Ausgaben** von „Postfach“
   - An: **An (Lieferant)**
   - Betreff: **Betreff**
   - Text: **Mailtext (HTML fuer den Flow)**, sonst nichts in das Feld schreiben

7. Unter „E-Mail senden“ (noch im Zweig „Falsch“): SharePoint **„Element aktualisieren“**,
   umbenennen in `Gesendet`.
   - ID und Betreff wie in Schritt 5
   - Status Value = `Gesendet`
   - Gesendet am: über „fx“ `utcNow()`

8. **Fehlerfall.** Schlägt „E-Mail senden“ fehl, überspringt Power Automate alles, was danach
   kommt, also auch „Gesendet“. Der Eintrag bliebe dann für immer auf „Wartet“. Deshalb hängt
   neben „Gesendet“ ein zweiter Schritt, der nur bei einem Fehler läuft:
   ```
   E-Mail senden
     ├── Gesendet   läuft, wenn das Senden geklappt hat (Standard)
     └── Fehler     läuft nur, wenn das Senden fehlgeschlagen ist oder hängt
   ```
   1. Mit der Maus auf die Verbindungslinie zwischen „E-Mail senden“ und „Gesendet“ gehen und
      auf das „+“ klicken. Im Menü **„Parallelen Zweig hinzufügen“** wählen, nicht „Aktion
      hinzufügen“.
   2. Rechts öffnet sich die Suche. SharePoint **„Element aktualisieren“** wählen. Die neue
      Aktion erscheint neben „Gesendet“, beide hängen unter „E-Mail senden“.
   3. Oben im Fenster der Aktion auf ihren Namen klicken (etwa „Element aktualisieren 2“) und
      in `Fehler` ändern.
   4. Reiter „Parameter“ ausfüllen:
      - Websiteadresse und Listenname wie im Trigger
      - ID: ins Feld klicken, Blitz-Symbol (dynamischer Inhalt), unter „Wenn ein Element
        erstellt wird“ **ID**
      - Betreff: ebenso **Betreff**
      - Erweiterte Parameter: **Status Value** und **Fehlermeldung** dazunehmen
      - Status Value: `Fehler`
      - Fehlermeldung: ins Feld klicken, „fx“-Symbol, diesen Ausdruck einfügen und
        „Hinzufügen“:
        ```
        coalesce(body('E-Mail_senden')?['error']?['message'], 'Versand fehlgeschlagen')
        ```
        `body('E-Mail_senden')` ist die Antwort der Sendeaktion, bei einem Fehler steht dort die
        Meldung von Outlook. Fehlt sie, steht „Versand fehlgeschlagen“ in der Liste. Der Name
        im Ausdruck ist der Aktionsname mit Unterstrich statt Leerzeichen. Heißt die Aktion
        anders, den Ausdruck anpassen.
   5. Reiter **„Einstellungen“**, Abschnitt **„Ausführen nach“**. Dort steht „E-Mail senden“
      mit vier Häkchen. Standard ist nur „ist erfolgreich“. Umstellen auf:
      - „ist erfolgreich“: **aus**
      - „hat Timeout“: **an**
      - „wurde übersprungen“: aus
      - „ist fehlgeschlagen“: **an**

      Bleibt „ist erfolgreich“ an, setzt „Fehler“ jede erfolgreich gesendete Mail auf
      „Fehler“.

9. „Speichern“. Die Flow-Prüfung oben darf keine Fehler zeigen.

### Schritt 6: Testen

1. Im Monitoring eine PDF-Rechnung mit „800k einschätzen“ öffnen.
2. Eine Einschätzung wählen, unter „An“ die **eigene** Adresse eintragen,
   „Speichern und senden“, Rückfrage bestätigen.
3. Nach etwa einer Minute ist die Mail im eigenen Posteingang, Absender ist das
   Werks-Postfach. In KreditorMails steht der Eintrag auf „Gesendet“. Im Monitoring zeigt die
   Rechnung nach dem Neuladen „Mail gesendet“.
4. Gegenprobe Werk: In der Liste KreditorMails einen Eintrag mit Werk `XYZ` und Status
   `Wartet` von Hand anlegen. Er muss auf „Fehler“ springen, mit dem Hinweis auf das fehlende
   Postfach.
5. Gegenprobe Versand: einen Eintrag mit Werk `ZAI`, An `test` (ohne @) und Status `Wartet`
   anlegen. Outlook lehnt die Adresse ab, „Gesendet“ wird übersprungen, und „Fehler“ schreibt
   die Meldung in die Liste. Das Monitoring lässt solche Adressen gar nicht erst durch, deshalb
   geht dieser Test nur direkt in der Liste.
6. Danach die Einschätzung der Testrechnung richtig setzen (Abzeichen anklicken, neu wählen,
   „Nur speichern“).

---

## Teil B: Ablauf in der Buchhaltung

### Wann eine Mail nötig ist

Bei jeder Eingangsrechnung, die als reines PDF ohne E-Rechnung kommt. Im Monitoring steht dann
in der Spalte „Buchung“ der Knopf **„800k einschätzen“** (bei Rechnungen ab 2028
„E-Rechnung anfordern“). Die Kachel **„800k-Einschätzung offen“** zeigt alle Rechnungen, bei
denen das noch fehlt.

Keine Mail nötig:
- Kleinbetragsrechnungen bis 250 € brutto. Ist der Betrag im Monitoring bekannt, tragen sie das
  Abzeichen „Kleinbetrag“. Bei PDF-Rechnungen fehlt er dort meist. Dann den Betrag im PDF
  ansehen oder im Hinweis in der Spalte „Konform.“ („Betrag laut Text: …“).
- Rechnungen von Kleinunternehmern (§ 19 UStG). Der Dialog weist darauf hin, wenn die Rechnung
  § 19 nennt.

### Schritt für Schritt

1. **Monitoring öffnen** und die Kachel „800k-Einschätzung offen“ anklicken.

2. Bei der Rechnung auf **„800k einschätzen“** klicken. Der Dialog liest das PDF und füllt
   Lieferant, Rechnungsnummer und Datum vor. Die Werte prüfen und bei Bedarf überschreiben.

3. **Lieferant**: Beim Tippen schlägt das Feld bekannte Lieferanten vor. Ist der Lieferant schon
   eingeschätzt, steht im Dialog „Bisher: …“ mit Einschätzung, Name und Datum.

4. **An** prüfen. Vorbelegt ist der Absender der Rechnungsmail. Ist das eine noreply-Adresse
   oder ein Versanddienst, die Rechnungs- oder Buchhaltungsadresse des Lieferanten eintragen
   (Briefkopf der Rechnung oder Kreditorenstamm).

5. **Einschätzung wählen**: „Vermutlich über 800.000 €“ oder „Vermutlich bis 800.000 €“.
   Anhaltspunkte bei Rechnungen aus 2026: über heißt größerer Lieferant, Konzern, bekannte
   Marke. Bis heißt Handwerker, kleiner Händler, Einzelunternehmen.

6. **Vorlage prüfen.** Betreff und Mailtext erscheinen passend zum Rechnungsjahr:

   | Rechnung aus | Vermutlich über 800.000 € | Vermutlich bis 800.000 € |
   |---|---|---|
   | 2026 | Ankündigung: ab 1. Januar 2027 bitte E-Rechnung | Hinweis: PDF noch erlaubt, ab 2028 nur noch E-Rechnung |
   | 2027 | **Variante 1, Rücksendung**: PDF wird nicht als Rechnung akzeptiert, bitte E-Rechnung oder Umsatzbestätigung | **Variante 2, Akzeptanz**: Rechnung wird verarbeitet, künftig bitte E-Rechnung |
   | ab 2028 | E-Rechnung anfordern (gilt für alle) | E-Rechnung anfordern (gilt für alle) |

   Den Text lesen und bei Bedarf anpassen. Unterschrieben wird mit dem eigenen Namen.

7. **Senden**: **„Speichern und senden“** und die Rückfrage bestätigen. Die Rückfrage nennt
   Empfänger und Werk und warnt, wenn es zur Rechnung schon eine Mail gibt.
   - An der Rechnung steht danach „Mail wartet“. Nach etwa einer Minute und dem Neuladen der
     Seite steht dort „Mail gesendet“.
   - **„In Outlook öffnen“** öffnet die Mail im eigenen Outlook, zum Beispiel um einen Anhang
     dazuzunehmen. Dann geht sie vom eigenen Postfach, außer man stellt unter „Von“ das
     Werks-Postfach ein.
   - **„Nur speichern“** sichert die Einschätzung ohne Mail.

   **Lieferant informiert** hält fest, ob der Lieferant Bescheid bekommen hat. Senden und
   „In Outlook öffnen“ setzen Ja. Bei „Nur speichern“ gilt der Wert im Feld, Standard ist
   Nein. Wurde der Lieferant anders informiert, zum Beispiel am Telefon, Ja wählen. In der
   Tabelle steht das in der Spalte „Lieferant informiert“:
   - **Ja** oder **Nein**: an dieser Rechnung eingeschätzt, mit oder ohne Info an den Lieferanten
   - **Automatik**: Der Lieferant war schon eingeschätzt, an dieser Rechnung war nichts zu tun
   - leer: noch nicht eingeschätzt, Kleinbetrag oder E-Rechnung

8. **Danach**
   - 2026 und 2027 mit Variante 2: Die Rechnung normal weiterverarbeiten.
   - 2027 mit Variante 1: Die PDF nicht als Eingangsrechnung buchen. Warten auf die E-Rechnung,
     sie läuft über den Eingang automatisch ein. Bestätigt der Lieferant stattdessen
     schriftlich, dass er unter 800.000 € liegt: das Abzeichen an der Rechnung anklicken,
     „Vermutlich bis 800.000 €“ wählen, „Nur speichern“, die Rechnung weiterverarbeiten und die
     Bestätigung bei der Rechnung aufbewahren.

### Weitere Rechnungen desselben Lieferanten

Die Einschätzung gilt für den Lieferanten. Weitere PDF-Rechnungen von ihm zeigen sie
automatisch als Abzeichen („über 800k“ oder „bis 800k“). Eine neue Mail ist nur nötig, wenn
die Vorlage es verlangt, vor allem 2027 bei „über 800k“: Jede weitere PDF wird wieder
zurückgeschickt. Dazu das Abzeichen an der neuen Rechnung anklicken und „Speichern und senden“.

### Wenn etwas nicht klappt

| Anzeige | Bedeutung | Was tun |
|---|---|---|
| „Mail fehlgeschlagen“ | Der Flow konnte nicht senden. Den Grund zeigt der Mauszeiger auf dem Abzeichen. | Häufig: Adresse falsch, Werk ohne Postfach im Flow, „Senden als“ fehlt. Adresse korrigieren und erneut „Speichern und senden“, sonst die IT informieren. |
| „Mail wartet“ länger als 10 Minuten | Der Flow ist nicht gelaufen. | IT informieren (Ausführungsverlauf des Flows „Kreditor-Mail senden“). Bis dahin „In Outlook öffnen“. |
| „Der Versand aus dem Werks-Postfach ist hier nicht eingerichtet“ | Teil A fehlt, oder die Rechnung ist noch keinem Werk zugeordnet. | Den Knopf „Speichern und Mail öffnen“ nehmen und aus Outlook senden. |
| Lieferant oder Nummer falsch gelesen | Das PDF ist ungewöhnlich aufgebaut oder ein Scan. | Felder im Dialog überschreiben. |

Jede Mail ist in der Liste KreditorMails mit Text, Empfänger, Zeitpunkt und Auftraggeber
festgehalten. Die Liste ist versioniert und dient als Nachweis.
