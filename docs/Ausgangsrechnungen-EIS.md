# Ausgangsrechnungen EIS (DIHAG Gienanth) im Konverter

Stand: 26.10.2026

Die Belege von DIHAG Gienanth kommen als PDF aus SAP, im Formular mit den nummerierten Feldern (10) bis (34). Der Konverter erkennt sie am Firmenfuß (dihag-gienanth.com, HRB 34046) und legt sie unter dem Werk EIS ab. Grundlage waren 15 Musterbelege: Einzel-, Sammel- und Lastschriftrechnungen, Gutschriften mit und ohne Retoure, Anzahlung und Schlussrechnung, jeweils Inland, EU und Drittland.

## Welche Belege umgewandelt werden

Umgewandelt werden Rechnungen an Kunden mit Rechnungsadresse im Inland. Dazu zählen auch steuerfreie innergemeinschaftliche Lieferungen an Kunden mit Sitz in Deutschland (zum Beispiel Rechnungsadresse in Deutschland, Lieferung nach Rumänien). Für diese Kunden gilt die E-Rechnungspflicht nach § 14 UStG.

Kunden mit Anschrift im EU-Ausland oder im Drittland bekommen die Rechnung wie bisher als PDF. Drittlandrechnungen müssen wegen der Präferenzangaben unterschrieben sein, ein aus Daten erzeugtes PDF hätte diese Unterschrift nicht. Lädt jemand einen solchen Beleg, weist der Konverter darauf hin und fragt beim Export nach.

## Was aus dem PDF übernommen wird

| Im PDF | Feld im Konverter | EN 16931 |
|---|---|---|
| Rechnung, Lastschrift / Gutschrift / Anzahlung | Rechnungsart 380 / 381 / 386 | BT-3 |
| Nummer, Datum | Rechnungsnummer, Rechnungsdatum | BT-1, BT-2 |
| Rechnungsadresse | Rechnungsempfänger | BG-7 |
| Kundennummer, Ihre UST-ID | Kunden-Nr., USt-IdNr. des Kunden | BT-46, BT-48 |
| Konto bei Empfänger | Lieferanten-Nr. beim Kunden | BT-29 |
| (3) Lieferscheinnummer, (4) Versanddatum | Lieferscheinnummer, Lieferdatum | BT-16, BT-72 |
| (11) Bestellnummer | Bestellnummer | BT-13 |
| (12) Ihr Kontakt, (13) Durchwahl | Ansprechpartner, Telefon | BT-41, BT-42 |
| (25) Versandanschrift, wenn anderer Kunde | Lieferanschrift | BG-15 |
| Zahlungsbedingung, Fälligkeitsdatum | Zahlungsbedingungen, Fälligkeit | BT-20, BT-9 |
| GS zu RE … vom … | Bezug auf Rechnung | BT-25, BT-26 |
| Bestelldatum, unsere Auftragsnummer, Lieferbedingung, Texte des Belegs | Hinweis zur Rechnung | BT-22 |
| Sach-Nr., Warennummer, Zuschläge | Positionsbeschreibung | BT-154 |
| LS … vom …, Auftragsnummer, Bestellnummer je Position | Positionshinweis | BT-127 |

Preise je 100 oder 1000 Stück rechnet der Konverter auf ein Stück um, so dass Menge mal Preis den gedruckten Gesamtpreis ergibt. Bei Zuschlägen (Metall- und Energieteuerung) gilt der Gesamtnettowert der Position. Bei einer Sammelrechnung ist das Lieferdatum das letzte Lieferscheindatum. Fehlt bei einer innergemeinschaftlichen Lieferung das Versanddatum (Lastschrift, Gutschrift), gilt das Belegdatum, weil EN 16931 dort ein Leistungsdatum verlangt.

## Kontakt-Mail des Rechnungsstellers

XRechnung verlangt eine Mail-Adresse des Rechnungsstellers (BT-43), auf dem SAP-Beleg steht keine. Der Konverter bildet sie aus „(12) Ihr Kontakt": SAP druckt „Nachname Vorname", daraus wird vorname.nachname@dihag-gienanth.com (Müller Anna wird zu anna.mueller@dihag-gienanth.com). Umlaute werden ausgeschrieben, zwei Vornamen mit Bindestrich verbunden. Stimmt eine Adresse nicht, lässt sie sich im Formular ändern.

## Rechnungsadressen der Kunden

Die Kunden-Nummern und Rechnungsmails aus „Vorgaben Fakturierung" lassen sich in den Einstellungen unter „Rechnungsadressen der Kunden" als Werk EIS einfügen. Danach schlägt der Konverter die Adresse beim Laden eines Belegs vor (siehe [Ausgangsrechnungen-ZAI.md](Ausgangsrechnungen-ZAI.md), Abschnitt Rechnungsadresse). Kunden, die laut Liste per Post oder gar nicht beliefert werden, stehen nicht darin.

## Prüfung

- Alle 14 Musterbelege mit Text liest der Parser vollständig. Der Beleg „FINR - AB - A" ist ein unterschriebener Scan ohne Text.
- Die daraus erzeugten XRechnungen hat der KoSIT-Validator geprüft: Alle Inlands- und EU-Belege sind ohne Fehler und ohne Warnung. Nicht konform sind nur Anzahlung und Gutschrift ins Drittland, weil dort kein Ansprechpartner und keine Fälligkeit gedruckt sind. Die werden nicht umgewandelt.
- Test im Repo: `node tests/eis-ausgang.test.js` (erfundene Belege im SAP-Layout).

## Grenzen

- Schlussrechnungen mit abgezogenen Anzahlungen (BT-113) unterstützt der Konverter noch nicht. In den Mustern kam das nur ins Drittland vor.
- Hat das Feld (10) Ihr Zeichen einen Wert, steht er vor der Bestellnummer in derselben Zeile. Das kam in den Mustern nicht vor und ist im Formular zu prüfen.
