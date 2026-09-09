<#
.SYNOPSIS
  Provisioniert die SharePoint-Rechnungsbibliotheken fuer das DIHAG-Rechnungsmonitoring.

.BESCHREIBUNG
  Legt auf EINER SharePoint-Site pro Werk / ERP-Quelle zwei Dokumentbibliotheken an:
    ERAR_<Werk>  = Eingangsrechnungen (Archiv)
    AR_<Werk>    = Ausgangsrechnungen
  Jede Bibliothek erhaelt denselben Spaltensatz (Rechnungs-Metadaten + Monitoring +
  Pruefpfad/GoBD). Die internen Spaltennamen sind identisch zu denen, die der
  Konverter (js/sharepoint.js) schreibt -> Konverter-Upload und automatisierter
  ERP-Eingang landen spaltenkompatibel in denselben Bibliotheken.

  Idempotent: bereits vorhandene Bibliotheken/Spalten werden nicht neu angelegt,
  sondern uebersprungen. Beliebig oft ausfuehrbar (z. B. wenn ein neues Werk dazukommt).

.EINMALIGE VORAUSSETZUNG (App-Registrierung, PnP 2.x)
  PnP.PowerShell braucht seit 2024 eine eigene Entra-App. Einmalig pro Tenant:

    Install-Module PnP.PowerShell -Scope CurrentUser
    Register-PnPEntraIDAppForInteractiveLogin `
        -ApplicationName "DIHAG-Rechnungsmonitoring" `
        -Tenant dihag.onmicrosoft.com

  Der Befehl gibt eine ClientId (App-ID) aus -> unten als -ClientId uebergeben.
  (Alternativ per Azure CLI: `az ad app create --display-name DIHAG-Rechnungsmonitoring`
   und die noetigen Graph/SharePoint-Delegated-Permissions im Portal erteilen.)

.BEISPIEL
  # Alle 10 DIHAG-Werke (Standard):
  .\provision-rechnungsmonitoring.ps1 `
      -SiteUrl https://dihag.sharepoint.com/sites/Rechnungsmonitoring `
      -ClientId 00000000-0000-0000-0000-000000000000

  # Nur einzelne / neue Werke nachziehen (idempotent, ueberspringt Bestehendes):
  .\provision-rechnungsmonitoring.ps1 -SiteUrl ... -ClientId ... `
      -Werke EIS,DSO,LEG,EWA,HOL,MEG,SCH,ZAI

  Testlauf ohne Aenderungen (zeigt nur, was passieren wuerde):
  .\provision-rechnungsmonitoring.ps1 -SiteUrl ... -ClientId ... -WhatIfOnly
#>
[CmdletBinding()]
param(
  # SharePoint-Site, auf der alle Bibliotheken liegen (Site vorher im Admin-Center anlegen).
  [Parameter(Mandatory)] [string]   $SiteUrl,

  # Entra-App-ID (ClientId) fuer den interaktiven PnP-Login (siehe Kopf: Register-PnPEntraIDAppForInteractiveLogin).
  [Parameter(Mandatory)] [string]   $ClientId,

  # ERP-Quellen / Werke (Kuerzel). Standard = alle 10 DIHAG-Werke.
  # Neues Werk dazu: hier ergaenzen (oder per -Werke uebergeben) und Skript erneut
  # ausfuehren -> nur die fehlenden Bibliotheken werden angelegt.
  [string[]] $Werke = @('WGC','SHB','EIS','DSO','LEG','EWA','HOL','MEG','SCH','ZAI'),

  # Nur anzeigen, nichts anlegen.
  [switch]   $WhatIfOnly
)

$ErrorActionPreference = 'Stop'
$SpaltenGruppe = 'DIHAG Rechnungsmonitoring'

# --- Richtungen (Bibliothekstypen je Werk) --------------------------------------
$Richtungen = @(
  [ordered]@{ Praefix = 'ERAR'; Bezeichnung = 'Eingangsrechnungen'; Richtung = 'Eingang' }
  [ordered]@{ Praefix = 'AR';   Bezeichnung = 'Ausgangsrechnungen'; Richtung = 'Ausgang' }
)

# --- Spaltendefinition ----------------------------------------------------------
# Name = interner Spaltenname (MUSS exakt zu js/sharepoint.js passen, wo markiert).
# Typ  = Text | Note | Currency | DateTime | Choice | Boolean
$Felder = @(
  # -- Identitaet / Kern (vom Konverter geschrieben) --
  @{ Name='Rechnungsart';        Titel='Rechnungsart (BT-3)';        Typ='Choice';   FillIn=$true; Choices=@('380 - Rechnung','381 - Kaufmaennische Gutschrift','383 - Belastungsanzeige','384 - Rechnungskorrektur','386 - Vorauszahlung','389 - Gutschrift (Selbstfakturierung)','326 - Teilrechnung') }
  @{ Name='Rechnungsdatum';      Titel='Rechnungsdatum';             Typ='DateTime'; DateOnly=$true }
  @{ Name='Faelligkeitsdatum';   Titel='Faellig am';                 Typ='DateTime'; DateOnly=$true }
  @{ Name='Rechnungssteller';    Titel='Rechnungssteller';           Typ='Text' }   # js/sharepoint.js
  @{ Name='RechnungsstellerUStID'; Titel='USt-IdNr. Rechnungssteller'; Typ='Text' }
  @{ Name='Rechnungsempfaenger'; Titel='Rechnungsempfaenger';        Typ='Text' }   # js/sharepoint.js
  @{ Name='Waehrung';            Titel='Waehrung';                   Typ='Text' }
  @{ Name='Nettobetrag';         Titel='Nettobetrag';                Typ='Currency' } # js/sharepoint.js
  @{ Name='MwStBetrag';          Titel='MwSt-Betrag';                Typ='Currency' } # js/sharepoint.js
  @{ Name='Bruttobetrag';        Titel='Bruttobetrag';               Typ='Currency' } # js/sharepoint.js
  @{ Name='Kaeuferreferenz';     Titel='Kaeuferreferenz (BT-10)';    Typ='Text' }
  @{ Name='Bestellnummer';       Titel='Bestellnummer (BT-13)';      Typ='Text' }
  @{ Name='Lieferscheinnummer';  Titel='Lieferscheinnummer (BT-16)'; Typ='Text' }
  @{ Name='Zahlungsreferenz';    Titel='Zahlungsreferenz (BT-83)';   Typ='Text' }

  # -- Klassifikation / Monitoring --
  @{ Name='Richtung';            Titel='Richtung';                   Typ='Choice';   Choices=@('Eingang','Ausgang') }
  @{ Name='Gesellschaft';        Titel='Werk / Gesellschaft';        Typ='Choice';   FillIn=$true; Refresh=$true; Choices=$Werke } # js/sharepoint.js
  @{ Name='ERPQuelle';           Titel='ERP-Quellsystem';            Typ='Text' }
  @{ Name='Format';              Titel='Format';                     Typ='Choice';   FillIn=$true; Choices=@('XRechnung','ZUGFeRD','EDI','PDF','Sonstige') } # js/sharepoint.js
  @{ Name='Syntax';              Titel='Syntax';                     Typ='Choice';   FillIn=$true; Choices=@('CII','UBL') }
  @{ Name='Verarbeitungsstatus'; Titel='Verarbeitungsstatus';        Typ='Choice';   Choices=@('Eingegangen','Konvertiert','Validiert','Geprueft','Gebucht','Archiviert','Fehler') }
  @{ Name='Konformitaet';        Titel='Konformitaet';               Typ='Choice';   Choices=@('Gruen - KoSIT ok','Gelb - Warnungen','Rot - Fehler','Ungeprueft') }
  @{ Name='PDFAStatus';          Titel='PDF/A-3b (veraPDF)';         Typ='Choice';   Choices=@('PDF/A-3b ok','PDF/A Fehler','Ungeprueft','n/a (nur XML)') }
  @{ Name='ValidierungsMeldung'; Titel='Validierungsmeldung';        Typ='Note' }
  @{ Name='Fehlermeldung';       Titel='Fehlermeldung';              Typ='Note' }
  @{ Name='Eingangszeitpunkt';   Titel='Eingang am';                 Typ='DateTime' }
  @{ Name='Konvertiertam';       Titel='Konvertiert am';             Typ='DateTime' }

  # -- Pruefpfad / GoBD (interne Namen exakt wie js/sharepoint.js) --
  @{ Name='Pruefstatus';         Titel='Pruefstatus';                Typ='Text' }   # js/sharepoint.js
  @{ Name='ManuelleAenderungen'; Titel='Manuelle Aenderungen';       Typ='Note' }   # js/sharepoint.js
  @{ Name='QuellPdfHash';        Titel='Quell-PDF-Hash (SHA-256)';   Typ='Text' }   # js/sharepoint.js
  @{ Name='XmlHash';             Titel='XML-Hash (SHA-256)';         Typ='Text' }
  @{ Name='GeprueftVon';         Titel='Geprueft von';               Typ='Text' }   # js/sharepoint.js
  @{ Name='StammdatenEntsperrt'; Titel='Stammdaten entsperrt';       Typ='Choice';   Choices=@('Ja','Nein') } # js/sharepoint.js
  @{ Name='GoBDArchiviert';      Titel='GoBD archiviert (Aufbewahrung gesetzt)'; Typ='Boolean' }

  # -- Verknuepfungen (vom Konverter geschrieben; Note wegen langer URLs) --
  @{ Name='XMLDateiUrl';         Titel='XML-Datei (URL)';            Typ='Note' }   # js/sharepoint.js
  @{ Name='ZUGFeRDPdfUrl';       Titel='ZUGFeRD-PDF (URL)';          Typ='Note' }   # js/sharepoint.js
  @{ Name='OriginalPdfName';     Titel='Original-PDF-Name';          Typ='Text' }   # js/sharepoint.js
)

# --- Hilfsfunktion: Spalte sicherstellen ---------------------------------------
function Ensure-Field {
  param([string]$Liste, [hashtable]$Spec)

  $vorhanden = Get-PnPField -List $Liste -Identity $Spec.Name -ErrorAction SilentlyContinue
  if ($vorhanden) {
    # Auswahllisten, die mit neuen Werken wachsen (z. B. Gesellschaft), auf
    # bestehenden Bibliotheken aktualisieren; alle anderen Spalten unveraendert lassen.
    if ($Spec.Refresh -and $Spec.Choices -and -not $WhatIfOnly) {
      Set-PnPField -List $Liste -Identity $Spec.Name -Values @{ Choices = [string[]]$Spec.Choices } | Out-Null
      Write-Host ("      ~ {0} (Auswahl aktualisiert)" -f $Spec.Name) -ForegroundColor DarkCyan
    } else {
      Write-Host ("      = {0}" -f $Spec.Name) -ForegroundColor DarkGray
    }
    return
  }
  if ($WhatIfOnly) { Write-Host ("      + {0} ({1}) [WhatIf]" -f $Spec.Name, $Spec.Typ) -ForegroundColor Yellow; return }

  switch ($Spec.Typ) {
    'Choice' {
      Add-PnPField -List $Liste -DisplayName $Spec.Titel -InternalName $Spec.Name -Type Choice `
                   -Choices $Spec.Choices -Group $SpaltenGruppe -AddToDefaultView | Out-Null
      if ($Spec.FillIn) { Set-PnPField -List $Liste -Identity $Spec.Name -Values @{ FillInChoice = $true } | Out-Null }
    }
    'Currency' { Add-PnPField -List $Liste -DisplayName $Spec.Titel -InternalName $Spec.Name -Type Currency -Group $SpaltenGruppe -AddToDefaultView | Out-Null }
    'Note'     { Add-PnPField -List $Liste -DisplayName $Spec.Titel -InternalName $Spec.Name -Type Note     -Group $SpaltenGruppe -AddToDefaultView | Out-Null }
    'Boolean'  { Add-PnPField -List $Liste -DisplayName $Spec.Titel -InternalName $Spec.Name -Type Boolean  -Group $SpaltenGruppe -AddToDefaultView | Out-Null }
    'DateTime' {
      Add-PnPField -List $Liste -DisplayName $Spec.Titel -InternalName $Spec.Name -Type DateTime -Group $SpaltenGruppe -AddToDefaultView | Out-Null
      # DisplayFormat 0 = nur Datum, 1 = Datum+Zeit
      $fmt = if ($Spec.DateOnly) { 0 } else { 1 }
      Set-PnPField -List $Liste -Identity $Spec.Name -Values @{ DisplayFormat = $fmt } | Out-Null
    }
    default    { Add-PnPField -List $Liste -DisplayName $Spec.Titel -InternalName $Spec.Name -Type Text     -Group $SpaltenGruppe -AddToDefaultView | Out-Null }
  }
  Write-Host ("      + {0} ({1})" -f $Spec.Name, $Spec.Typ) -ForegroundColor Green
}

# --- Verbindung -----------------------------------------------------------------
Write-Host "Verbinde mit $SiteUrl ..." -ForegroundColor Cyan
Connect-PnPOnline -Url $SiteUrl -Interactive -ClientId $ClientId

# --- Bibliotheken + Spalten -----------------------------------------------------
foreach ($werk in $Werke) {
  foreach ($r in $Richtungen) {
    $listTitle = "$($r.Praefix)_$werk"                       # z. B. ERAR_WGC
    $listDesc  = "$($r.Bezeichnung) $werk (automatisierter ERP-Eingang)"

    Write-Host ""
    Write-Host "== Bibliothek: $listTitle ($($r.Bezeichnung)) ==" -ForegroundColor Cyan

    $liste = Get-PnPList -Identity $listTitle -ErrorAction SilentlyContinue
    if (-not $liste) {
      if ($WhatIfOnly) {
        Write-Host "   (wuerde angelegt) [WhatIf]" -ForegroundColor Yellow
      } else {
        New-PnPList -Title $listTitle -Template DocumentLibrary -OnQuickLaunch | Out-Null
        Set-PnPList -Identity $listTitle -Description $listDesc -EnableVersioning $true | Out-Null
        # Title-Spalte als "Rechnungsnummer" beschriften (Konverter schreibt Title)
        Set-PnPField -List $listTitle -Identity 'Title' -Values @{ Title = 'Rechnungsnummer' } | Out-Null
        Write-Host "   Bibliothek angelegt (Versionierung an)." -ForegroundColor Green
      }
    } else {
      Write-Host "   Bibliothek existiert bereits." -ForegroundColor DarkGray
    }

    Write-Host "   Spalten:"
    foreach ($f in $Felder) { Ensure-Field -Liste $listTitle -Spec $f }

    # Sinnvolle Vorbelegung: Richtung + Werk je Bibliothek als Default
    if (-not $WhatIfOnly) {
      Set-PnPField -List $listTitle -Identity 'Richtung'     -Values @{ DefaultValue = $r.Richtung } -ErrorAction SilentlyContinue | Out-Null
      Set-PnPField -List $listTitle -Identity 'Gesellschaft' -Values @{ DefaultValue = $werk }       -ErrorAction SilentlyContinue | Out-Null
    }
  }
}

Write-Host ""
Write-Host "Fertig. $($Werke.Count) Werk(e) x $($Richtungen.Count) Richtungen = $($Werke.Count * $Richtungen.Count) Bibliothek(en)." -ForegroundColor Cyan
Disconnect-PnPOnline
