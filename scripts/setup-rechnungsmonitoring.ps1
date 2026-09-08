<#
.SYNOPSIS
  Ein-Klick-Setup fuer das DIHAG-Rechnungsmonitoring:
  (1) legt die SharePoint-Site an (falls noch nicht vorhanden) und
  (2) provisioniert die Bibliotheken ERAR_<Werk> / AR_<Werk> mit allen Spalten.

.BESCHREIBUNG
  Wrapper um provision-rechnungsmonitoring.ps1 (muss im selben Ordner liegen).
  Idempotent: existiert die Site bereits, wird Schritt 1 uebersprungen; bereits
  vorhandene Bibliotheken/Spalten werden nicht neu angelegt.

.EINMALIGE VORAUSSETZUNG
  Install-Module PnP.PowerShell -Scope CurrentUser
  Register-PnPEntraIDAppForInteractiveLogin -ApplicationName "DIHAG-Rechnungsmonitoring" -Tenant dihag.onmicrosoft.com
  -> Die ausgegebene ClientId (App-ID) unten als -ClientId uebergeben.
  Der angemeldete Benutzer braucht das Recht, Site Collections anzulegen.

.BEISPIEL
  .\setup-rechnungsmonitoring.ps1 `
      -SiteUrl https://dihag.sharepoint.com/sites/Rechnungsmonitoring `
      -ClientId 00000000-0000-0000-0000-000000000000 `
      -Werke WGC,SHB
#>
[CmdletBinding()]
param(
  # Ziel-URL der Site (Site Collection), z. B. https://dihag.sharepoint.com/sites/Rechnungsmonitoring
  [Parameter(Mandatory)] [string]   $SiteUrl,

  # Entra-App-ID (ClientId) fuer den interaktiven PnP-Login.
  [Parameter(Mandatory)] [string]   $ClientId,

  # ERP-Quellen / Werke.
  [string[]] $Werke = @('WGC','SHB'),

  # Anzeigename der Site.
  [string]   $Title = 'Rechnungsmonitoring',

  # Site-Typ: CommunicationSite (Standard, keine M365-Gruppe) oder TeamSite.
  [ValidateSet('CommunicationSite','TeamSite')] [string] $SiteType = 'CommunicationSite'
)

$ErrorActionPreference = 'Stop'

# --- Schritt 1: Site anlegen (falls noetig) -------------------------------------
Write-Host "== Schritt 1: Site pruefen/anlegen ==" -ForegroundColor Cyan
Write-Host "   Ziel: $SiteUrl"

$siteExists = $false
try {
  Connect-PnPOnline -Url $SiteUrl -Interactive -ClientId $ClientId
  $null = Get-PnPWeb
  $siteExists = $true
  Write-Host "   Site existiert bereits -> Schritt 1 uebersprungen." -ForegroundColor DarkGray
  Disconnect-PnPOnline
} catch {
  Write-Host "   Site noch nicht vorhanden -> wird angelegt." -ForegroundColor Yellow
}

if (-not $siteExists) {
  # Tenant-Root aus der Ziel-URL ableiten (z. B. https://dihag.sharepoint.com)
  $root = ([Uri]$SiteUrl).GetLeftPart([System.UriPartial]::Authority)
  Connect-PnPOnline -Url $root -Interactive -ClientId $ClientId

  $desc = 'Zentrale Eingangs- und Ausgangsrechnungen aller Werke'
  if ($SiteType -eq 'CommunicationSite') {
    New-PnPSite -Type CommunicationSite -Title $Title -Url $SiteUrl -Description $desc -Wait | Out-Null
  } else {
    New-PnPSite -Type TeamSiteWithoutMicrosoft365Group -Title $Title -Url $SiteUrl -Description $desc -Wait | Out-Null
  }
  Disconnect-PnPOnline
  Write-Host "   Site angelegt: $SiteUrl" -ForegroundColor Green
}

# --- Schritt 2: Bibliotheken + Spalten ------------------------------------------
Write-Host ""
Write-Host "== Schritt 2: Bibliotheken + Spalten provisionieren ==" -ForegroundColor Cyan

$provision = Join-Path $PSScriptRoot 'provision-rechnungsmonitoring.ps1'
if (-not (Test-Path $provision)) {
  throw "provision-rechnungsmonitoring.ps1 nicht gefunden neben diesem Skript ($PSScriptRoot)."
}

& $provision -SiteUrl $SiteUrl -ClientId $ClientId -Werke $Werke

Write-Host ""
Write-Host "Setup abgeschlossen. In js/monitoring.js ggf. MON.siteHost auf die Site setzen:" -ForegroundColor Cyan
$hostPath = ([Uri]$SiteUrl).Host + ':' + ([Uri]$SiteUrl).AbsolutePath
Write-Host "   siteHost: '$hostPath'" -ForegroundColor Gray
