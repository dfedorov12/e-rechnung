# Ausgangsrechnungen ZAI im Konverter

Stand: 26.10.2026

Die Zaigler-Rechnungen kommen als PDF aus ALF. Der Konverter liest sie aus und erzeugt daraus XRechnung oder ZUGFeRD. Grundlage für die Anpassung waren die Rechnungsmails, die im Oktober 2026 an Kunden gingen, und der handschriftliche Abgleich von Rechnung 2026.001965 mit dem Original.

## Was aus dem PDF übernommen wird

| Im PDF | Feld im Konverter | EN 16931 |
|---|---|---|
| Beleg-Nr. | Rechnungsnummer | BT-1 |
| Beleg-Datum | Rechnungsdatum | BT-2 |
| Storno-Rechnung, „zu Belegnr. …" | Rechnungsart 381 (Gutschrift) und Bezug auf Rechnung | BT-3, BT-25 |
| Kunden-Nr. | Kunden-Nr. | BT-46 |
| Lieferanten-Nr. | Lieferanten-Nr. beim Kunden | BT-29 |
| Best.Nr. (erste im Beleg) | Bestellnummer des Kunden | BT-13 |
| Best.Nr. … Pos. 20 | Bestellposition der Rechnungsposition | BT-132 |
| Bestellung vom, Best.Nr., Komm., Auftrags/Pos.-Nr., Lieferschein-Nr., Lieferdatum | Positionshinweis | BT-127 |
| Zeichnung, Guss-Nr. und weitere Zeilen unter der Position | Positionsbeschreibung | BT-154 |
| Zahlungsbedingung | Zahlungsbedingungen | BT-20 |
| AGB-Hinweis, Leistungstag, Lieferbedingung | Hinweis zur Rechnung | BT-22 |
| MwSt.-Betrag der Summenzeile | MwSt. laut Original | BT-110 |

Seitenköpfe und die leeren Zwischensummen am Seitenende („19,00 % 0,00") werden übersprungen, mehrseitige Rechnungen kommen damit vollständig an. Bepreiste Zeilen ohne eigene Positionsnummer (zum Beispiel Erstmusterkosten) werden als Unterposition angelegt.

Im Formular stehen die neuen Kopffelder unter den Zahlungsangaben. Jede Position hat einen Knopf „Details". Er klappt Positionsbeschreibung, Positionshinweis und Bestellposition auf. Ein Haken am Knopf zeigt, dass dort etwas eingetragen ist.

## MwSt. laut Original

ALF rundet die Steuer anders als der Konverter. Bei Rechnung 2026.001965 stehen im Original 186,69 € MwSt. und 1.169,31 € brutto, gerechnet ergeben sich 186,70 € und 1.169,32 €. Der Konverter übernimmt deshalb den Steuerbetrag aus dem PDF, wenn die Rechnung genau einen Steuersatz hat und die Abweichung höchstens 5 Cent beträgt. In der Zusammenfassung steht dann „(laut Original)". Weicht der Betrag stärker ab, etwa weil jemand Positionen geändert hat, rechnet der Konverter selbst. EN 16931 lässt solche Rundungsdifferenzen zu (BR-CO-17).

Auch beim Einzelpreis rechnet ALF mit mehr Stellen, als es druckt. Der Konverter nimmt den gedruckten Preis, wenn Menge mal Preis den gedruckten Gesamtpreis ergibt. Sonst nimmt er so wenige Nachkommastellen wie nötig, damit der Gesamtpreis stimmt.

## Rechnungsadresse des Kunden

Im ALF-PDF steht keine Rechnungsadresse des Kunden, nur die Mail der Sachbearbeitung im eigenen Haus. Die XRechnung braucht aber eine elektronische Adresse des Empfängers (BT-49), und das muss das Rechnungspostfach des Kunden sein. Der Konverter übernimmt die Mail aus dem PDF deshalb nicht mehr.

Stattdessen merkt sich die App je Werk und Kunde die Adresse, an die exportiert wurde. Beim nächsten Beleg desselben Kunden schlägt sie die Adresse vor. Gesucht wird nach Kunden-Nr., dann nach USt-IdNr., dann nach dem Namen. Gespeichert wird in SharePoint (Dokumente/E-Rechnung/kunden-rechnungsmail.json), nicht im Code, weil die Seite öffentlich ist.

Trägt jemand eine Adresse der eigenen Firma ein (gleiche Domain wie die Verkäufer-Mail oder die eigene Anmeldung), fragt der Export nach. Solche Adressen merkt sich die App nicht. Kunden mit Leitweg-ID brauchen keine Mail und werden nicht gemerkt.

Admins pflegen die Liste unter Einstellungen, Abschnitt „Rechnungsadressen der Kunden". Dort lassen sich Einträge suchen, anlegen und löschen. Mehrere Kunden auf einmal gehen über „Mehrere auf einmal einfügen", eine Zeile je Kunde im Format `Werk;Kunden-Nr.;Kunde;Mail`. Mit Tabulator getrennte Zeilen aus Excel gehen auch.

## Prüfung

- Alle 13 Rechnungs-PDFs aus den Oktober-Mails (eine der 14 Mails war doppelt) liest der Parser vollständig: Nummer, Kunde, Bestellung, Lieferschein, Positionen und Nettosumme stimmen mit dem Original überein, die Storno-Rechnung 2026.002056 kommt als Gutschrift mit Bezug auf 2026.002027.
- Die daraus erzeugten XRechnungen hat der KoSIT-Validator geprüft: 13 von 13 ohne Fehler und ohne Warnung.
- Tests im Repo: `node tests/zai-ausgang.test.js` (Parser mit erfundenem Beleg, Rundung) und `node tests/kundenmail.test.js` (Rechnungsadressen).

## Grenzen

- Die Rechnungsadresse muss beim ersten Beleg je Kunde einmal eingetragen werden, entweder im Konverter oder vorab in den Einstellungen.
- Die Bestellnummer im Kopf (BT-13) ist die erste Best.Nr. im Beleg. Hat eine Rechnung Positionen aus mehreren Bestellungen, stehen die übrigen im Positionshinweis der jeweiligen Position.
- Die lesbare PDF-Ansicht von XML-Dateien (/api/convert und Monitoring) zeigt die neuen Felder erst nach dem nächsten Deploy der Function App.
