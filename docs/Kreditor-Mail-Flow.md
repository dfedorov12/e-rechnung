# Kreditor-Mails aus dem Werks-Postfach senden

Die Buchhaltung schätzt im Monitoring ein, ob ein Lieferant über oder bis 800.000 € Umsatz
liegt, und bekommt dazu die passende Mailvorlage (Variante 1 Rücksendung, Variante 2
Akzeptanz, für 2026 und ab 2028 eigene Texte). Mit **„Speichern und senden“** geht diese Mail
ohne Outlook direkt aus dem Rechnungspostfach des Werks an den Lieferanten.

Klick für Klick, mit dem Ablauf in der Buchhaltung: [Lieferanten-Mails-Anleitung.md](Lieferanten-Mails-Anleitung.md)

## So läuft es

```
Monitoring (800k-Dialog)
  „Speichern und senden“ → Eintrag in der Liste KreditorMails (Status „Wartet“)
                                   │
Flow „Kreditor-Mail senden“  ◄─────┘  (Trigger: neuer Eintrag)
  Postfach aus dem Werk bestimmen (fest im Flow)
  E-Mail aus dem freigegebenen Postfach senden
  Eintrag auf „Gesendet“ bzw. „Fehler“ setzen
                                   │
Monitoring  ◄──────────────────────┘  Badge „Mail gesendet“ an der Rechnung
```

Warum über eine Liste und nicht direkt aus der Webseite: Die Webseite liegt öffentlich auf
GitHub Pages. Ein Flow-Link mit Schlüssel stünde dort für jeden lesbar, und wer ihn kennt,
könnte aus dem Werks-Postfach senden. Die Liste dagegen schützt SharePoint mit den normalen
Rechten, und jeder Versand ist dort mit Text, Empfänger, Zeitpunkt und Auftraggeber
dokumentiert.

Das Postfach je Werk steht **im Flow**, nicht in der Liste. So kann niemand über einen
Listeneintrag aus einem anderen Postfach senden.

## 1. Spalte und Liste anlegen

Das Provisionierungsskript legt beides an (idempotent, bestehende Bibliotheken bleiben):

```powershell
cd scripts
.\provision-rechnungsmonitoring.ps1 -SiteUrl https://dihag.sharepoint.com/sites/Rechnungsmonitoring -ClientId df9691fc-bed8-4134-820e-99654640eb0e
```

- Neue Spalte **AbsenderMail** („Absender der Rechnungsmail“) in allen `ERAR_<Werk>`,
  `AR_<Werk>` und `Rechnungseingang`.
- Neue Liste **KreditorMails** mit Betreff, An, Werk, Art, Status (Standard „Wartet“),
  MailText, MailHtml, Rechnung, RechnungKey, Lieferant, RechnungUrl, AngefordertVon,
  GesendetAm, Fehlermeldung.

## 2. Rechte

1. **Liste KreditorMails:** Vererbung unterbrechen. Die Buchhaltung bekommt
   „Mitwirken“ (zum Anlegen der Aufträge), das Konto der Flow-Verbindung ebenfalls. Alle
   anderen lesen höchstens. Wer hier einen Eintrag anlegen darf, kann über den Flow aus dem
   Werks-Postfach senden.
2. **Werks-Postfächer:** Das Konto, mit dem die Outlook-Verbindung im Flow angelegt ist,
   braucht **„Senden als“** auf jedes Werks-Postfach (Exchange Admin Center → Postfach →
   Delegierung → Senden als). Ohne das schlägt der Versand fehl und der Eintrag steht auf
   „Fehler“.

## 3. Eingangs-Flows: Absender mitschreiben

In jedem Eingangs-Flow (WGC und ZAI) in der Aktion **„Dateieigenschaften aktualisieren“** das
Feld **„Absender der Rechnungsmail“** setzen:

```
if(empty(triggerOutputs()?['body/replyTo']), triggerOutputs()?['body/from'], triggerOutputs()?['body/replyTo'])
```

Die Antwortadresse (Reply-To) geht vor, weil manche Lieferanten von einer noreply-Adresse senden
und die Antwortadresse auf ihre Buchhaltung setzen. Ohne Reply-To bleibt es der Absender.

Dann steht die Adresse des Lieferanten bei jeder neuen Rechnung im Monitoring und der Dialog
trägt sie unter „An“ vor. Bei älteren Rechnungen gibt man sie im Dialog selbst ein. Die
Adresse aus „An“ wird beim Speichern beim Lieferanten gemerkt (Feld `mail` in der
Lieferantendatei) und geht bei seinen weiteren Rechnungen dem Absender der Rechnungsmail vor.
Kommt die Mail aus dem eigenen Haus (Scanner, Weiterleitung) oder von einer noreply-Adresse,
übergeht der Dialog den Absender und nimmt die Adresse aus dem PDF-Text, wenn dort eine des
Lieferanten steht.

## 4. Neuer Flow „Kreditor-Mail senden“

Automatisierter Cloud-Flow, ein Flow für alle Werke.

1. **Trigger** SharePoint *„Wenn ein Element erstellt wird“*
   - Websiteadresse: `https://dihag.sharepoint.com/sites/Rechnungsmonitoring`
   - Listenname: `KreditorMails`
   - Einstellungen → Triggerbedingung:
     ```
     @equals(triggerOutputs()?['body/Status/Value'], 'Wartet')
     ```

2. **Verfassen**, umbenennen in `Postfach`, Ausdruck:
   ```
   if(equals(triggerOutputs()?['body/Werk'],'ZAI'),'er-zaigler@dihag.com',if(equals(triggerOutputs()?['body/Werk'],'WGC'),'<Rechnungspostfach WGC>',''))
   ```
   `<Rechnungspostfach WGC>` durch die echte Adresse ersetzen. Kommt ein Werk dazu, hier
   eine Stufe ergänzen.

3. **Bedingung** `empty(outputs('Postfach'))` ist gleich `true`
   - **Ja:** SharePoint *„Element aktualisieren“* (Liste KreditorMails, ID aus dem Trigger,
     Betreff = Betreff aus dem Trigger), Status = `Fehler`, Fehlermeldung =
     `Für dieses Werk ist im Flow kein Postfach hinterlegt.`
   - **Nein:** weiter mit 4 bis 6.

4. Office 365 Outlook *„E-Mail aus einem freigegebenen Postfach senden (V2)“*, umbenennen in
   `E-Mail_senden`
   - Ursprüngliche Postfachadresse: `outputs('Postfach')`
   - An: **An** (dynamischer Inhalt)
   - Betreff: **Betreff**
   - Text: **MailHtml** (fertiges HTML aus dem Monitoring, Absätze und Umbrüche bleiben)

5. SharePoint *„Element aktualisieren“*, umbenennen in `Gesendet`
   - ID: **ID** aus dem Trigger, Betreff: **Betreff**
   - Status: `Gesendet`
   - Gesendet am: `utcNow()`

6. SharePoint *„Element aktualisieren“*, umbenennen in `Fehler`
   - **Ausführen nach** (Menü „…“ → Ausführen nach): nur `E-Mail_senden` *ist fehlgeschlagen*
     und *Zeitüberschreitung*
   - ID, Betreff wie oben, Status: `Fehler`
   - Fehlermeldung:
     ```
     coalesce(body('E-Mail_senden')?['error']?['message'], 'Versand fehlgeschlagen')
     ```

## 4a. Zurückweisung und Hinweis auf Abweichungen automatisch senden (Eingangs-Flows)

Der Prüfdienst liefert für zwei Fälle eine fertige Mail an den Lieferanten in
`kreditorAktion.mail` (Betreff, HTML, Text, Anhang und der Wert für die Spalte Art):

| Prüfergebnis | Buchung | Mail | Art |
|---|---|---|---|
| rot (EN 16931 nicht bestanden) oder Profil MINIMUM bzw. BASIC-WL | zurückgewiesen | Zurückweisung, korrigierte E-Rechnung anfordern | `Zurueckweisung` |
| gelb (nur Warnungen) | unter Vorbehalt | Hinweis auf geringfügige Abweichungen, Rechnung wird verarbeitet | `Abweichung` |

Die Absätze sind die Vorlagen der Buchhaltung, wörtlich. Die Mail ist im Layout der DIHAG
gesetzt (Kopf mit Gesellschaft, Kasten mit Rechnungsnummer, Datum und Betrag, roter bzw.
oranger Streifen) und nennt den Prüfbericht im Anhang. Kopf und Gruß tragen den Namen der
Gesellschaft des Postfachs (aus `?werk=`), nicht den Empfänger aus der Rechnung, der bei
fehlerhaften Rechnungen oft falsch drinsteht. Die Befunde stehen nur im Anhang, einem
Prüfbericht im selben Layout für XRechnung (KoSIT) und ZUGFeRD (Mustang): Rechnungsdaten,
Prüfwerkzeug, Ergebnis, alle Meldungen und der Rechnungsinhalt. Der Original-Bericht von KoSIT
liegt weiter neben der Rechnung im Archiv. Texte und Layout stehen in `api/src/kreditormail.js`.

Keine Mail kommt bei sonstigen Rechnungen (PDF ohne XML, PDF/A-3 fehlt, dafür die
800k-Einschätzung im Monitoring), bei grün und bei Ausgangsrechnungen, die im Postfach landen.

Der Eingangs-Flow sendet diese Mail selbst und trägt sie danach in KreditorMails ein. Über
einen Eintrag mit Status „Wartet“ ginge der Anhang nicht mit, weil „Element erstellen“ keine
Anlagen kennt. Der Eintrag bekommt deshalb gleich „Gesendet“ oder „Fehler“, und „Kreditor-Mail
senden“ fasst ihn nicht an.

In jedem Eingangs-Flow in der Schleife über die Anlagen nach „Dateieigenschaften
aktualisieren“:

1. „Neuer Schritt“, **Bedingung**. Links als Ausdruck
   `empty(body('HTTP_1')?['kreditorAktion']?['mail'])`, Operator „ist gleich“, rechts `false`
   (als Ausdruck).
2. Im Ja-Zweig Office 365 Outlook **„E-Mail aus einem freigegebenen Postfach senden (V2)“**,
   umbenennen in `E-Mail_an_Lieferant`:
   - Ursprüngliche Postfachadresse: das Rechnungspostfach des Werks (dasselbe wie im Trigger)
   - An:
     ```
     if(empty(triggerOutputs()?['body/replyTo']), triggerOutputs()?['body/from'], triggerOutputs()?['body/replyTo'])
     ```
   - Betreff: `body('HTTP_1')?['kreditorAktion']?['mail']?['betreff']`
   - Text: `body('HTTP_1')?['kreditorAktion']?['mail']?['html']`
   - Erweiterte Parameter → Anlagen, eine Anlage:
     - Name: `body('HTTP_1')?['kreditorAktion']?['mail']?['anhang']?['name']`
     - Inhalt: `base64ToBinary(body('HTTP_1')?['kreditorAktion']?['mail']?['anhang']?['base64'])`
3. Darunter SharePoint **„Element erstellen“**, umbenennen in `Mail_festhalten`. Menü „…“ →
   **Ausführen nach**: `E-Mail_an_Lieferant` *ist erfolgreich* und *ist fehlgeschlagen*.
   Website Rechnungsmonitoring, Liste KreditorMails, die Felder als Ausdruck:
   - Titel: `body('HTTP_1')?['kreditorAktion']?['mail']?['betreff']`
   - An: derselbe Ausdruck wie in Schritt 2
   - Werk: `WGC` bzw. `ZAI` (fester Text)
   - Art: `body('HTTP_1')?['kreditorAktion']?['mail']?['art']` (Spalte Art → „Benutzerdefinierten
     Wert eingeben“)
   - MailHtml: `body('HTTP_1')?['kreditorAktion']?['mail']?['html']`
   - MailText: `body('HTTP_1')?['kreditorAktion']?['mail']?['text']`
   - Rechnung:
     ```
     coalesce(body('HTTP_1')?['daten']?['nummer'], body('Datei_erstellen_Original')?['Name'])
     ```
   - RechnungKey (verbindet den Eintrag mit der Zeile im Monitoring):
     ```
     toLower(concat('e|', substring(body('Datei_erstellen_Original')?['Name'], 0, lastIndexOf(body('Datei_erstellen_Original')?['Name'], '.'))))
     ```
   - Lieferant: `coalesce(body('HTTP_1')?['daten']?['steller'], '')`
   - RechnungUrl:
     ```
     concat('https://dihag.sharepoint.com/sites/Rechnungsmonitoring', body('Datei_erstellen_Original')?['Path'])
     ```
   - Status (nie „Wartet“, sonst sendet „Kreditor-Mail senden“ ein zweites Mal):
     ```
     if(equals(actions('E-Mail_an_Lieferant')?['status'], 'Succeeded'), 'Gesendet', 'Fehler')
     ```
   - Gesendet am: `if(equals(actions('E-Mail_an_Lieferant')?['status'], 'Succeeded'), utcNow(), null)`
   - Fehlermeldung:
     ```
     if(equals(actions('E-Mail_an_Lieferant')?['status'], 'Succeeded'), '', coalesce(body('E-Mail_an_Lieferant')?['error']?['message'], 'Versand fehlgeschlagen'))
     ```
   - AngefordertVon: `Eingangs-Flow`
4. Speichern.

Das Konto der Outlook-Verbindung braucht „Senden als“ auf das Werks-Postfach (siehe 2.).
Schlägt der Versand fehl, läuft der Flow weiter, die Rechnung ist abgelegt, und KreditorMails
zeigt den Fehler.

Die Mail geht an den Absender der Rechnungsmail. Hat ein Kollege die Rechnung weitergeleitet,
bekommt er die Mail und gibt sie an den Lieferanten weiter. Im Monitoring steht danach in der
Spalte „Lieferant informiert“ „Ja“, die aufgeklappte Zeile zeigt unter „Mails“ Art, Empfänger
und Versandzeit.

Wer den ersten Entwurf dieses Schritts schon gebaut hat („Element erstellen“ mit Status
„Wartet“, MailHtml mit `concat('<p>Guten Tag,</p>…')`): Bedingung wie oben ändern, die
Senden-Aktion davor einfügen und im Element Titel, Art, MailHtml, MailText, Status, Gesendet am
und Fehlermeldung wie oben setzen.

## 4b. Dateiname beim Eingang mitschreiben

Der Flow benennt jede lesbare Rechnung nach `Rechnungsnummer_USt-IdNr.` um. Den Namen des
Anhangs sieht man danach nicht mehr. In „Dateieigenschaften aktualisieren“ unter „Erweiterte
Parameter“ das Feld **„Original-PDF-Name“** dazunehmen und als Ausdruck
`items('Auf_alle_anwenden_2')?['name']` eintragen. Das Monitoring zeigt ihn in den Details unter
„Dateien“ als „Dateiname beim Eingang“ (gilt auch für XML-Anhänge).

## 5. Testen

1. Im Monitoring eine sonstige Rechnung öffnen (Button „800k einschätzen“).
2. Einschätzung wählen, unter „An“ die **eigene** Adresse eintragen, „Speichern und senden“.
3. Nach etwa einer Minute ist die Mail im eigenen Posteingang, Absender ist das
   Werks-Postfach. In KreditorMails steht der Eintrag auf „Gesendet“, im Monitoring (nach dem
   Neuladen) zeigt die Rechnung „Mail gesendet“.
4. Gegenprobe: Werk ohne Postfach im Flow ergibt „Fehler“ mit Hinweis, im Monitoring
   „Mail fehlgeschlagen“.

## Hinweise

- Ohne die Liste KreditorMails zeigt der Dialog weiter „Speichern und Mail öffnen“ (Outlook).
  „In Outlook öffnen“ bleibt auch mit Liste als Weg, um den Text vorher anzupassen und selbst
  zu senden.
- Manche Lieferanten schicken Rechnungen von einer noreply-Adresse. Die Adresse unter „An“
  deshalb vor dem Senden prüfen, sie lässt sich überschreiben.
- Gibt es zur Rechnung schon eine Mail, fragt der Dialog vor dem zweiten Versand nach.
- Nachweis für jede Mail ist der Eintrag in KreditorMails (Versionierung ist an).
