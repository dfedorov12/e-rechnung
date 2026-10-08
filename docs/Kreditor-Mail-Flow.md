# Kreditor-Mails aus dem Werks-Postfach senden

Die Buchhaltung schätzt im Monitoring ein, ob ein Lieferant über oder bis 800.000 € Umsatz
liegt, und bekommt dazu die passende Mailvorlage (Variante 1 Rücksendung, Variante 2
Akzeptanz, für 2026 und ab 2028 eigene Texte). Mit **„Speichern und senden“** geht diese Mail
ohne Outlook direkt aus dem Rechnungspostfach des Werks an den Lieferanten.

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
   „Bearbeiten“ (zum Anlegen der Aufträge), das Konto der Flow-Verbindung ebenfalls. Alle
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
triggerOutputs()?['body/from']
```

Dann steht die Adresse des Lieferanten bei jeder neuen Rechnung im Monitoring und der Dialog
trägt sie unter „An“ vor. Bei älteren Rechnungen gibt man sie im Dialog selbst ein.

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
