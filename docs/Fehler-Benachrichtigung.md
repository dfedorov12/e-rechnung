# Fehler-Benachrichtigung pro Werk

Pro Werk kann eine **E-Mail-Adresse** hinterlegt werden, die benachrichtigt wird,
wenn bei einer Rechnung etwas schiefläuft (Validierung „rot", Konvertierungs-/
Verarbeitungsfehler). Zwei Teile:

1. **Einstellung** (im Tool, Reiter *Einstellungen* → „Fehler-Benachrichtigung pro
   Werk"): speichert die Adressen als JSON in SharePoint.
2. **Versand** (Power Automate): liest die Adresse zum Werk und schickt bei Fehler eine
   Mail mit dem Sachverhalt.

## 1) Einstellung / Speicherort

Die Adressen werden vom Tool als JSON abgelegt:

- Site: `https://dihag.sharepoint.com/sites/IT`
- Bibliothek/Pfad: `Dokumente/E-Rechnung/fehler-mail-config.json`
- Inhalt: `{ "WGC": "team-wgc@dihag.com", "SHB": "buchhaltung-shb@dihag.com", … }`
  (nur befüllte Werke; Schlüssel = Werk-Kürzel in Großbuchstaben)

Gespeichert wird admin-seitig über `spSaveFehlerConfig()` (js/sharepoint.js).

## 2) Power-Automate-Flow „Fehler melden"

**Trigger:** *Wenn ein Element erstellt oder geändert wird* (SharePoint) auf der
Monitoring-Site, Bibliothek `AR_<Werk>` bzw. `ERAR_<Werk>` (bzw. `Rechnungseingang`).

1. **Bedingung „ist ein Fehler?"** – auslösen nur wenn
   `Verarbeitungsstatus` **ist gleich** `Fehler`  **oder**  `Konformitaet`
   **beginnt mit** `Rot`. (Sonst: Flow beenden.)
   - Doppel-Mails vermeiden: eine Boolean-Spalte `Benachrichtigt` ergänzen und nur
     senden, wenn sie leer/false ist; danach auf true setzen.

2. **Werk-Adresse lesen** – Aktion *SharePoint – HTTP-Anforderung an SharePoint senden*:
   | Feld | Wert |
   |------|------|
   | Websiteadresse | `https://dihag.sharepoint.com/sites/IT` |
   | Methode | `GET` |
   | URI | `_api/web/GetFileByServerRelativeUrl('/sites/IT/Dokumente/E-Rechnung/fehler-mail-config.json')/$value` |
   | Header | `Accept` : `application/json` |

   Danach *JSON analysieren* auf den Body (Schema: Objekt mit Werk-Kürzeln → String).

3. **Empfänger bestimmen** (Compose):
   `outputs('JSON_analysieren')?[toUpper(triggerBody()?['Gesellschaft'])]`
   → die Mailadresse des Werks (leer, wenn nicht hinterlegt).

4. **Bedingung** – Empfänger ist **nicht leer**.

5. **E-Mail senden (V2)**:
   - **An:** die Adresse aus Schritt 3
   - **Betreff:** `E-Rechnung Fehler – @{triggerBody()?['Gesellschaft']} · Rechnung @{triggerBody()?['Title']}`
   - **Text** (Sachverhalt):
     ```
     Bei einer Rechnung ist ein Fehler aufgetreten.

     Werk:            @{triggerBody()?['Gesellschaft']}
     Richtung:        @{triggerBody()?['Richtung']}
     Rechnungsnummer: @{triggerBody()?['Title']}
     Rechnungssteller:@{triggerBody()?['Rechnungssteller']}
     Status:          @{triggerBody()?['Verarbeitungsstatus']}
     Konformität:     @{triggerBody()?['Konformitaet']}
     Meldung:         @{triggerBody()?['ValidierungsMeldung']} @{triggerBody()?['Fehlermeldung']}

     Datei öffnen:    @{triggerBody()?['{Link}']}
     ```

6. Optional: `Benachrichtigt` = true setzen (Schritt 1).

## Woran „schiefläuft" festgemacht wird

- **Validierung rot:** KoSIT lehnt ab → `/api/validate` bzw. `/api/intake` liefert
  `konform:rot`; der Validierungs-Flow setzt `Konformitaet = Rot – Fehler` und
  `Verarbeitungsstatus = Fehler`.
- **Konvertierungs-/Verarbeitungsfehler:** der jeweilige Flow setzt
  `Verarbeitungsstatus = Fehler` + `Fehlermeldung`.
- **Werk-Fehlleitung (Eingang):** `/api/intake` meldet `werkMismatch` → im Eingangs-
  Flow als Fehler kennzeichnen (siehe docs/Eingangsrechnungen-Flow.md).

So greift **eine** Benachrichtigungsregel für alle Fehlerquellen, weil alle im
Monitoring denselben `Verarbeitungsstatus = Fehler` setzen.
