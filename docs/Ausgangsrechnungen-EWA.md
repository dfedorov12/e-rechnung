# Ausgangsrechnungen EWA (Eisenwerk Arnstadt) im Konverter

Stand: 27.10.2026

Die Belege des Eisenwerks Arnstadt kommen aus SAP als Adobe-Formular, auf Deutsch, Englisch oder Französisch und in der Währung des Kunden (EUR, GBP, CZK). Der Konverter erkennt das Formular an seinem Aufbau (Nummer, Kundenauftrag, Positionen mit „Material") und das Werk am Fuß (ewa-guss.de, HRB 110887). Die Lintorfer Eisengießerei (LEG) nutzt dasselbe Formular, siehe [Ausgangsrechnungen-LEG.md](Ausgangsrechnungen-LEG.md). Grundlage waren elf Musterbelege: Rechnungen und Gutschriften, Inland, EU und Großbritannien, mit Skonto, Teuerungszuschlag, 100-%-Abschlag und Verpackungszuschlag.

## Welche Belege ohne Rückfrage umgewandelt werden

Wie bei EIS (Gienanth): Pflicht ist die E-Rechnung nur für Kunden mit Sitz im Inland (§ 14 UStG). Maßgeblich ist das Land in der Rechnungsadresse.

- Rechnungsadresse in Deutschland: Der Konverter wandelt ohne Rückfrage um.
- EU-Ausland und Drittland (auch Großbritannien): Er weist beim Laden darauf hin und fragt beim Export, ob trotzdem eine E-Rechnung entstehen soll.

Anders als bei Gienanth unterschreibt EWA Drittlandrechnungen nicht, es gibt also keine Erinnerung an ein unterschriebenes Original. Eine Anlage lässt sich trotzdem beifügen.

## Wie der Beleg gelesen wird

Im Kopf stehen links die Anschriften und rechts Beschriftung und Wert in zwei Spalten. Weil pdf.js die Zeilen beider Seiten mischt, liest der Konverter den Kopf über die Position der Textstücke. Positionen und Summen liest er über die Zeilen. Zahlen werden im Format des Belegs gelesen: 32,400.00, 32.400,00 oder 32 400,00. Das Format ergibt sich aus den Beträgen, nicht aus der Sprache, denn es gibt deutsche Belege mit englischen Zahlen.

| Im PDF (de / en / fr) | Feld im Konverter | EN 16931 |
|---|---|---|
| Rechnung, Gutschrift / Invoice / Facture | Rechnungsart 380 oder 381 | BT-3 |
| Nummer, Datum | Rechnungsnummer, Rechnungsdatum | BT-1, BT-2 |
| Währung / Currency / Monnaie | Währung | BT-5 |
| Anschrift links oben | Rechnungsempfänger mit Adresszusatz (c/o, Postfach, Abteilung) | BG-8, BT-163 |
| Mail im Anschriftfeld (manche Kunden) | Mail des Rechnungsempfängers | BT-49 |
| Versandanschrift / Ship-to address / Adresse d'expédition | Lieferanschrift | BG-15 |
| Kundennummer, Ihre UST-ID | Kunden-Nr., USt-IdNr. des Kunden | BT-46, BT-48 |
| Referenznummer / Reference Number / votre no. de commande | Bestellnummer | BT-13 |
| Lieferungsnummer, Liefer/Leistungsdatum | Lieferschein, Lieferdatum | BT-16, BT-72 |
| Sachbearbeiter / Clerk | Ansprechpartner | BT-41 |
| Telefon / Tel. / Phone im Kopf (falls gedruckt) | Telefon des Ansprechpartners | BT-42 |
| Zahlungsbedingungen, Datum „ohne Abzug" | Zahlungsbedingungen, Fälligkeit | BT-20, BT-9 |
| Kundenauftrag, Lieferbedingungen, Hinweis | Hinweis zur Rechnung | BT-22 |
| Kundenmaterial, Werkstoff, Zuschläge, Herkunftsland, Warennummer, Positionstexte aus SAP | Positionsbeschreibung | BT-154 |
| zu Bestellung, Gutschriftsanforderung, Charge | Positionshinweis | BT-127 |

Von Hand eingegebene Positionstexte (alle Zeilen unter einer Position, die keine Menge, Kondition oder Warennummer sind) landen in der Positionsbeschreibung (BT-154). Sie steht im XML an der Position und im lesbaren PDF unter der Positionszeile. Texte vor der ersten Position gehen in den Hinweis zur Rechnung (BT-22).

Der Positionswert ist die Summe aller Konditionen der Position (Preis, Teuerungszuschlag, Abschlag). Steht eine Zeile „Nettowert" da, gilt sie. Preise je 3 oder je 1.000 rechnet der Konverter auf ein Stück um, so dass der gedruckte Positionswert herauskommt. Ein Zuschlag unter der Zwischensumme (zum Beispiel Verpackungszuschlag) wird eine eigene Position. Die Bankverbindung kommt aus dem Beleg, GBP-Rechnungen nennen ein eigenes Konto.

## Kontakt und Versand

Kontakt-Mail des Rechnungsstellers (BT-43) ist **invoicing@ewa-guss.de**, nicht die info@ aus dem Fuß. Auf dieses Postfach hat der ganze Vertrieb Zugriff, und bei den Staatsbahnen ist nur diese Adresse hinterlegt.

„Mail erstellen“ legt den Outlook-Entwurf mit invoicing@ewa-guss.de als Absender an. Senden lässt er sich nur mit dem Recht „Senden als“ oder „Senden im Auftrag von“ auf dieses Postfach (Exchange Admin Center, Postfach, Delegierung). Lesezugriff allein reicht dafür nicht.

Telefon (BT-42): Die Belege drucken beim Sachbearbeiter nur den Namen. Deshalb steht im XML die Zentrale (+49 3628 596 101). Druckt das SAP-Formular unter dem Sachbearbeiter eine Zeile „Telefon +49 3628 596 1xx“, übernimmt der Konverter diese Durchwahl.

Betreff: Der Entwurf heißt „Rechnung <Nummer> – Eisenwerk Arnstadt GmbH“. Vor dem Senden lässt er sich in Outlook ändern. Feste Betreffvorgaben je Kunde gibt es noch nicht.

## Proformarechnungen

Eine Proformarechnung ist keine Rechnung im Sinne von § 14 UStG, für sie gibt es keine E-Rechnungspflicht. XRechnung kennt dafür auch keinen Belegtyp. Erkennt der Konverter in der Titelzeile „Proformarechnung“, „Pro-forma-Rechnung“, „Pro forma invoice“ oder „Facture pro forma“, weist er beim Laden darauf hin und fragt vor Export und Mail nach. Druckt der Beleg keine Bankverbindung, nimmt der Konverter das EUR-Konto aus den Stammdaten.

## Rechnungsadresse des Kunden

Der Konverter übernimmt die Rechnungsmail des Kunden (BT-49) aus dem Beleg, wenn sie im Anschriftfeld steht oder in einer Zeile „Rechnungsempfänger: …“. Fehlt sie dort, greift die Liste „Rechnungsadressen der Kunden“ unter Einstellungen (je Werk und Kunden-Nr., auch als Sammelimport aus Excel). Außerdem merkt sich der Konverter jede Adresse, an die exportiert wurde. Die SAP-Stammdaten müssen dafür nicht geändert werden. Wer die Adresse auf dem Beleg haben will, kann sie trotzdem im Anschriftfeld drucken lassen.

## Steuer, Modellkosten und Weiterberechnungen

Modellkosten, Modellanpassungen und andere Weiterberechnungen kommen als normale Rechnung (380). Jede Position bleibt eine Position, die Einheit „LE“ wird zu Stück. Die Steuer übernimmt der Konverter aus dem Beleg und rechnet sie nicht selbst:

| Auf dem Beleg | Steuerkategorie im XML |
|---|---|
| Umsatzsteuer mit Satz (19 %) | S, Normalsatz |
| 0 % und Hinweis auf § 13b oder Reverse Charge | AE |
| 0 % und Hinweis auf innergemeinschaftliche Lieferung | K |
| 0 % und Hinweis auf Ausfuhr | G |

Ob ein Beleg steuerpflichtig ist, entscheidet also der Steuerschlüssel in SAP. Bei Modellkosten für Kunden im EU-Ausland sollte die Buchhaltung prüfen, ob der Steuerschlüssel stimmt. Das gilt besonders, wenn das Modell in Arnstadt bleibt und nicht zum Kunden geht.

## Währung, Adresszusatz, Skonto

Diese drei Teile gelten für alle Werke:

- **Währung (BT-5):** Das Formular hat ein Feld Währung. XML, Summen im Formular, Mailtext und lesbares PDF nehmen die gewählte Währung. Im Monitoring stehen die Beträge in der Währung der Rechnung.
- **Adresszusatz (BT-163):** eigenes Feld beim Rechnungsempfänger, im XML als zweite Adresszeile.
- **Skonto:** Steht in den Zahlungsbedingungen „Bis zum 03.11.2026 erhalten Sie 2,000 % Skonto", schreibt der Konverter zusätzlich die maschinenlesbare Zeile nach XRechnung (#SKONTO#TAGE=14#PROZENT=2.00#) in BT-20. Die Tage zählen ab Rechnungsdatum. Das lesbare PDF zeigt nur den Text.

## Prüfung

- Alle elf Musterbelege liest der Parser vollständig. Nettosumme, Steuer und Endbetrag stimmen mit dem Beleg überein, auch beim 100-%-Abschlag (Endbetrag 0,00) und bei der Gutschrift mit Verpackungszuschlag.
- KoSIT: alle elf XRechnungen ohne Fehler und ohne Warnung, darunter GBP, CZK und die Skonto-Zeile.
- Im Browser über den normalen Upload geprüft: GBP-Rechnung mit Rechnungsmail aus dem Anschriftfeld und GBP-Konto, EUR-Rechnung mit Lieferanschrift und Skonto.
- Test im Repo: `node tests/ewa-ausgang.test.js` (erfundene Belege in drei Sprachen als Textstücke mit Position).

## Grenzen

- Eine Rechnung in Fremdwährung mit deutscher Umsatzsteuer bekommt keine zusätzliche Steuerangabe in Euro (BT-6, BT-111). In den Mustern kam Fremdwährung nur steuerfrei vor.
- Rechnungsadressen der Kunden lernt der Konverter beim Export (siehe [Ausgangsrechnungen-ZAI.md](Ausgangsrechnungen-ZAI.md)). Eine Liste wie bei Gienanth gab es für EWA nicht.
- Proformarechnungen waren nicht unter den Musterbelegen. Erkannt werden sie an der Titelzeile, siehe oben.
