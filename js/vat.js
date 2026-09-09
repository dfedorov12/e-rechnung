/**
 * Qualifizierte USt-IdNr-Prüfung im Ausgangsrechnungs-Prozess
 * ===========================================================
 * Ruft den serverseitigen Endpoint /api/vat (BZSt qualifiziert, VIES-Fallback)
 * mit den Empfänger-Daten des Formulars auf und zeigt Ergebnis + Bericht (Nachweis).
 *
 * Warum serverseitig: BZSt/VIES liefern keine Browser-CORS-Freigabe und drosseln;
 * der Endpoint bündelt Aufruf, Cache und Bericht. Kein Key nötig (anonymous).
 *
 * Der eigentliche Prüf-Endpoint: api/src/functions/vat.js
 */
(function () {
  'use strict';

  var VAT_API = 'https://erechnung-xml2pdf.azurewebsites.net/api/vat';

  function $(id) { return document.getElementById(id); }
  function val(id) { var e = $(id); return e ? String(e.value || '').trim() : ''; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  async function pruefen() {
    var btn = $('vat-check-btn'), out = $('vat-check-result');
    var vatId = val('kaeufer-vat'), vatIdOwn = val('verkaeufer-vat');

    if (!vatId) { render({ fehler: 'Bitte zuerst die USt-IdNr. des Empfängers eintragen.' }); return; }
    if (!vatIdOwn) { render({ fehler: 'Eigene USt-IdNr. (Verkäufer) fehlt – für die qualifizierte Anfrage nötig.' }); return; }

    var label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Prüfe…';
    try {
      var r = await fetch(VAT_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vatIdOwn: vatIdOwn,
          vatId: vatId,
          company: val('kaeufer'),
          city: val('kaeufer-stadt'),
          zip: val('kaeufer-plz'),
          street: val('kaeufer-strasse'),
        }),
      });
      var j = await r.json();
      render(j);
    } catch (e) {
      render({ fehler: 'Prüfdienst nicht erreichbar: ' + (e && e.message ? e.message : e) });
    } finally {
      btn.disabled = false; btn.textContent = label;
    }
  }

  function render(j) {
    var out = $('vat-check-result');
    out.hidden = false;

    if (j.fehler)         { out.className = 'vat-err';     out.innerHTML = '<div class="vat-head">⚠ ' + esc(j.fehler) + '</div>'; return; }
    if (j.error)          { out.className = 'vat-err';     out.innerHTML = '<div class="vat-head">⚠ ' + esc(j.error) + '</div>'; return; }
    if (j.moeglich === false) { out.className = 'vat-neutral'; out.innerHTML = '<div class="vat-head">ℹ ' + esc(j.grund) + '</div>'; return; }

    var ok = j.gueltig === true;
    out.className = ok ? 'vat-ok' : 'vat-bad';

    var rows = '';
    var zeilen = (j.bericht && j.bericht.zeilen) || [];
    for (var i = 0; i < zeilen.length; i++) {
      rows += '<tr><td>' + esc(zeilen[i][0]) + '</td><td>' + esc(zeilen[i][1]) + '</td></tr>';
    }

    out.innerHTML =
      '<div class="vat-head">' + (ok ? '✓ USt-IdNr. gültig' : '✗ USt-IdNr. NICHT gültig') +
        ' · ' + (j.qualifiziert ? 'qualifiziert' : 'einfach') + ' · ' + esc(j.quelle || '') +
        (j.cached ? ' · (gecacht)' : '') + '</div>' +
      '<table class="vat-table">' + rows + '</table>' +
      '<div class="vat-actions">' +
        '<button type="button" id="vat-print">Bericht drucken</button>' +
        '<button type="button" id="vat-copy">Als Text kopieren</button>' +
      '</div>';

    $('vat-print').addEventListener('click', function () { druckeBericht(j); });
    $('vat-copy').addEventListener('click', function () {
      try { navigator.clipboard.writeText(berichtText(j)); this.textContent = 'Kopiert ✓'; } catch (e) {}
    });

    // Ergebnis global hinterlegen, damit Export/Ablage es später mitnehmen kann.
    window._letzteVatPruefung = j;
  }

  function berichtText(j) {
    var titel = (j.bericht && j.bericht.titel) || 'USt-IdNr-Bestätigung';
    var zeilen = (j.bericht && j.bericht.zeilen) || [];
    return titel + '\n' + zeilen.map(function (z) { return z[0] + ': ' + z[1]; }).join('\n');
  }

  function druckeBericht(j) {
    var w = window.open('', '_blank', 'width=680,height=820');
    if (!w) return;
    var zeilen = (j.bericht && j.bericht.zeilen) || [];
    var rows = zeilen.map(function (z) {
      return '<tr><td style="padding:5px 12px;color:#555;vertical-align:top">' + esc(z[0]) +
             '</td><td style="padding:5px 12px;font-weight:600">' + esc(z[1]) + '</td></tr>';
    }).join('');
    w.document.write(
      '<!doctype html><html lang="de"><head><meta charset="utf-8">' +
      '<title>USt-IdNr-Bestätigung</title></head>' +
      '<body style="font-family:Arial,Helvetica,sans-serif;color:#1A2644;margin:32px">' +
      '<h2 style="color:#17509E;margin:0 0 4px">USt-IdNr-Bestätigung</h2>' +
      '<div style="font-size:12px;color:#666;margin-bottom:16px">' +
        (j.qualifiziert ? 'Qualifizierte Bestätigung' : 'Einfache Bestätigung') + ' · ' + esc(j.quelle || '') + '</div>' +
      '<table style="border-collapse:collapse;font-size:13px">' + rows + '</table>' +
      '<p style="margin-top:24px;font-size:11px;color:#777">Ausdruck erzeugt am ' +
        new Date().toLocaleString('de-DE') + '. Nachweis: Anfrage-ID ' + esc(j.anfrageId || '—') + '.</p>' +
      '</body></html>');
    w.document.close(); w.focus(); w.print();
  }

  // Für Export/Monitoring: liefert die letzte Prüfung nur, wenn sie zur aktuellen
  // Empfänger-USt-IdNr passt (verhindert Anhängen eines veralteten Ergebnisses).
  function norm(s) { return String(s || '').replace(/\s+/g, '').toUpperCase(); }
  window.matchingVatCheck = function (kaeufervat) {
    var j = window._letzteVatPruefung;
    if (!j || j.moeglich === false || j.fehler || j.error) return null;
    return (j.pruefUstId && norm(j.pruefUstId) === norm(kaeufervat)) ? j : null;
  };
  window.vatBerichtText = berichtText;

  document.addEventListener('DOMContentLoaded', function () {
    var btn = $('vat-check-btn');
    if (btn) btn.addEventListener('click', pruefen);
    var kv = $('kaeufer-vat');
    if (kv) kv.addEventListener('input', function () {
      var o = $('vat-check-result'); if (o) o.hidden = true;
    });
  });
})();
