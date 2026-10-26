# Ausgangsrechnungen EWA (Eisenwerk Arnstadt) im Konverter

Stand: 26.10.2026

Die Belege des Eisenwerks Arnstadt kommen aus SAP als Adobe-Formular, auf Deutsch, Englisch oder Französisch und in der Währung des Kunden (EUR, GBP, CZK). Der Konverter erkennt sie an der Absenderzeile („Eisenwerk Arnstadt GmbH | Bierweg …") und legt sie unter dem Werk EWA ab. Grundlage waren elf Musterbelege: Rechnungen und Gutschriften, Inland, EU und Großbritannien, mit Skonto, Teuerungszuschlag, 100-%-Abschlag und Verpackungszuschlag.

## Wie der Beleg gelesen wird

Im Kopf stehen links die Anschriften und rechts Beschriftung und Wert in zwei Spalten. Weil pdf.js die Zeilen beider Seiten mischt, liest der Konverter den Kopf über die Position der Textstücke. Positionen und Summen liest er über die Zeilen. Zahlen werden im Format der Belegsprache gelesen: englisch 32,400.00, deutsch 32.400,00, französisch 32 400,00.

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
| Zahlungsbedingungen, Datum „ohne Abzug" | Zahlungsbedingungen, Fälligkeit | BT-20, BT-9 |
| Kundenauftrag, Lieferbedingungen, Hinweis | Hinweis zur Rechnung | BT-22 |
| Kundenmaterial, Werkstoff, Zuschläge, Herkunftsland, Warennummer | Positionsbeschreibung | BT-154 |
| zu Bestellung, Gutschriftsanforderung, Charge | Positionshinweis | BT-127 |

Der Positionswert ist die Summe aller Konditionen der Position (Preis, Teuerungszuschlag, Abschlag). Steht eine Zeile „Nettowert" da, gilt sie. Preise je 3 oder je 1.000 rechnet der Konverter auf ein Stück um, so dass der gedruckte Positionswert herauskommt. Ein Zuschlag unter der Zwischensumme (zum Beispiel Verpackungszuschlag) wird eine eigene Position. Die Bankverbindung kommt aus dem Beleg, GBP-Rechnungen nennen ein eigenes Konto.

Die Kontakt-Mail des Rechnungsstellers ist info@ewa-guss.de, sie steht im Fuß jedes Belegs.

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

- EWA wandelt alle Belege um, auch an Kunden im Ausland. Soll es wie bei EIS (Gienanth) nur das Inland sein, reicht in js/parser.js beim Werk EWA der Eintrag `_nurInland: true`.
- Eine Rechnung in Fremdwährung mit deutscher Umsatzsteuer bekommt keine zusätzliche Steuerangabe in Euro (BT-6, BT-111). In den Mustern kam Fremdwährung nur steuerfrei vor.
- Rechnungsadressen der Kunden lernt der Konverter beim Export (siehe [Ausgangsrechnungen-ZAI.md](Ausgangsrechnungen-ZAI.md)). Eine Liste wie bei Gienanth gab es für EWA nicht.
