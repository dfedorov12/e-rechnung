# Ausgangsrechnungen EIS (DIHAG Gienanth) im Konverter

Stand: 26.10.2026

Die Belege von DIHAG Gienanth kommen als PDF aus SAP, im Formular mit den nummerierten Feldern (10) bis (34). Der Konverter erkennt sie am Firmenfuß (dihag-gienanth.com, HRB 34046) und legt sie unter dem Werk EIS ab. Grundlage waren 15 Musterbelege: Einzel-, Sammel- und Lastschriftrechnungen, Gutschriften mit und ohne Retoure, Anzahlung und Schlussrechnung, jeweils Inland, EU und Drittland.

## Welche Belege umgewandelt werden

Umgewandelt werden Rechnungen an Kunden mit Rechnungsadresse im Inland. Dazu zählen auch steuerfreie innergemeinschaftliche Lieferungen an Kunden mit Sitz in Deutschland (zum Beispiel Rechnungsadresse in Deutschland, Lieferung nach Rumänien). Für diese Kunden gilt die E-Rechnungspflicht nach § 14 UStG.

Kunden mit Anschrift im EU-Ausland bekommen die Rechnung wie bisher als PDF. Lädt jemand einen solchen Beleg, weist der Konverter darauf hin und fragt beim Export nach.

## Drittland

Drittlandrechnungen sind vorbereitet und lassen sich umwandeln, eine Pflicht gibt es dafür nicht. Weil sie wegen der Präferenzangaben unterschrieben sein müssen, das aus Daten erzeugte PDF aber keine Unterschrift trägt, kommt das unterschriebene Original als Anlage (BG-24) in die E-Rechnung:

1. Das SAP-PDF (mit Text) in den Konverter laden. Daraus kommen die Rechnungsdaten.
2. Unter „Anlagen" den eingescannten, unterschriebenen Beleg wählen. Die Beschreibung lautet bei Drittland „Unterschriebene Rechnung (Präferenzangaben)".
3. Exportieren. Bei XRechnung steckt die Datei im XML, bei ZUGFeRD hängt sie als Datei am PDF und das XML nennt sie. Die lesbare PDF-Ansicht im Monitoring führt die Anlage unter „Referenzen" auf.

Lädt jemand einen Drittlandbeleg, erinnert der Konverter an die Anlage. Ohne Anlage fragt der Export nach. Ein eingescannter Beleg allein (ohne Text) taugt nicht als Datenquelle.

Schlussrechnungen ziehen die erhaltenen Anzahlungen ab: Der Block „payments received until date of final invoice" (deutsch „erhaltene Anzahlungen") wird als „bereits gezahlt" (BT-113) übernommen, der Zahlbetrag ist der Rest. Die Anzahlungsrechnung steht als Bezug (BT-25) und im Hinweis. Das Feld „Bereits gezahlt" lässt sich im Formular auch von Hand füllen. Gutschriften ohne Zahlungsziel bekommen die Zahlungsbedingung „Gutschrift", weil EN 16931 Fälligkeit oder Zahlungsbedingung verlangt. Steht auf dem Beleg kein Ansprechpartner (zum Beispiel bei der Anzahlung), meldet das Formular das Feld als fehlend. Trägt man den Namen ein, folgt die Mail dem Schema unten.

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
- Die daraus erzeugten XRechnungen hat der KoSIT-Validator geprüft: Alle Inlands- und EU-Belege sind ohne Fehler und ohne Warnung. Im Drittland sind Rechnung und Gutschrift grün, auch mit dem 1 MB großen Scan als Anlage im XML. Eine nach dem Scan nachgebaute Schlussrechnung (175.000 EUR, Anzahlung 52.500 EUR, Zahlbetrag 122.500 EUR) ist grün. Die Anzahlungsanforderung ist erst grün, wenn ein Ansprechpartner eingetragen ist. Für den Code 386 meldet XRechnung eine Warnung, er ist aber zulässig.
- Test im Repo: `node tests/eis-ausgang.test.js` (erfundene Belege im SAP-Layout, auch Drittland, Schlussrechnung und Gutschrift ohne Zahlungsziel).

## Grenzen

- Die Schlussrechnung lag nur als Scan vor. Das Lesen des Anzahlungsblocks ist an einem nachgebauten Text geprüft und am ersten echten SAP-PDF noch einmal anzusehen.
- Hat das Feld (10) Ihr Zeichen einen Wert, steht er vor der Bestellnummer in derselben Zeile. Das kam in den Mustern nicht vor und ist im Formular zu prüfen.
