<#
.SYNOPSIS
  Migriert die Pruefdienste KoSIT + veraPDF von Azure Container Instances (ACI,
  Dauerbetrieb) auf Azure Container Apps (min-replicas=1, HTTP-Autoscale).

.BESCHREIBUNG
  - Legt ein Container Apps Environment an (Consumption).
  - Erstellt/aktualisiert je einen Container App pro Dienst aus DENSELBEN ACR-Images
    (dihagerechnungacr.azurecr.io/erechnung-kosit|verapdf:latest), Port 8080,
    HTTPS-Ingress (extern), min 1 / max N Replicas, Skalierung nach HTTP-Concurrency.
  - Stellt die Function-App-Einstellungen KOSIT_DAEMON_URL / VERAPDF_URL auf die
    neuen HTTPS-FQDNs um (nur wenn die Health-Checks gruen sind).

  Reversibel: die alten ACIs bleiben als Fallback bestehen, bis sie manuell
  geloescht werden (Befehl wird am Ende ausgegeben). Rollback = App-Einstellungen
  wieder auf die ACI-URLs setzen.

  Voraussetzung: az CLI angemeldet (az login), Rechte auf rg-erechnung-api,
  ACR-Adminkonto aktiv (ist es).

.BEISPIEL
  .\deploy-containerapps.ps1
  .\deploy-containerapps.ps1 -MaxReplicas 10 -HttpConcurrency 20
  .\deploy-containerapps.ps1 -SkipFunctionUpdate   # nur Apps bauen, URLs manuell umstellen
#>
[CmdletBinding()]
param(
  [string]$ResourceGroup   = 'rg-erechnung-api',
  [string]$Location        = 'germanywestcentral',
  [string]$Acr             = 'dihagerechnungacr',
  [string]$FunctionApp     = 'erechnung-xml2pdf',
  [string]$EnvName         = 'erechnung-cae',   # Container Apps Environment
  [int]   $MaxReplicas     = 5,
  [int]   $HttpConcurrency = 10,
  [switch]$SkipFunctionUpdate
)

$ErrorActionPreference = 'Stop'
# az ist ein natives Programm: Nicht-Null-Exit soll NICHT automatisch werfen
# (wir pruefen Existenz per leerer Ausgabe und melden Fehler selbst).
$PSNativeCommandUseErrorActionPreference = $false

# name / cpu / mem (Container Apps verlangt Verhaeltnis mem = cpu * 2 GiB)
$apps = @(
  [ordered]@{ name = 'erechnung-kosit';   image = "$Acr.azurecr.io/erechnung-kosit:latest";   cpu = '1.0'; mem = '2.0Gi' }
  [ordered]@{ name = 'erechnung-verapdf'; image = "$Acr.azurecr.io/erechnung-verapdf:latest"; cpu = '1.0'; mem = '2.0Gi' }
)

function Fail($msg) { Write-Host "FEHLER: $msg" -ForegroundColor Red; exit 1 }

Write-Host '== 0) az-Erweiterung + Resource Provider ==' -ForegroundColor Cyan
az extension add --name containerapp --upgrade --only-show-errors | Out-Null
az provider register --namespace Microsoft.App --wait | Out-Null
az provider register --namespace Microsoft.OperationalInsights --wait | Out-Null

Write-Host '== 1) ACR-Zugangsdaten ==' -ForegroundColor Cyan
$acrServer = "$Acr.azurecr.io"
$acrUser = az acr credential show -n $Acr --query username -o tsv
$acrPass = az acr credential show -n $Acr --query "passwords[0].value" -o tsv
if ([string]::IsNullOrWhiteSpace($acrUser) -or [string]::IsNullOrWhiteSpace($acrPass)) {
  Fail "ACR-Adminzugang nicht lesbar. 'az acr update -n $Acr --admin-enabled true' ausfuehren."
}

Write-Host '== 2) Container Apps Environment ==' -ForegroundColor Cyan
$envExists = az containerapp env show -g $ResourceGroup -n $EnvName --query name -o tsv 2>$null
if ([string]::IsNullOrWhiteSpace($envExists)) {
  az containerapp env create -g $ResourceGroup -n $EnvName --location $Location --only-show-errors | Out-Null
  Write-Host "   Environment '$EnvName' angelegt." -ForegroundColor Green
} else {
  Write-Host "   Environment '$EnvName' existiert bereits." -ForegroundColor DarkGray
}

Write-Host '== 3) Apps anlegen/aktualisieren ==' -ForegroundColor Cyan
foreach ($a in $apps) {
  $exists = az containerapp show -g $ResourceGroup -n $a.name --query name -o tsv 2>$null
  if ([string]::IsNullOrWhiteSpace($exists)) {
    az containerapp create -g $ResourceGroup -n $a.name --environment $EnvName `
      --image $a.image --target-port 8080 --ingress external --transport auto `
      --cpu $a.cpu --memory $a.mem --min-replicas 1 --max-replicas $MaxReplicas `
      --registry-server $acrServer --registry-username $acrUser --registry-password $acrPass `
      --scale-rule-name http-rule --scale-rule-type http `
      --scale-rule-http-concurrency $HttpConcurrency `
      --only-show-errors | Out-Null
    Write-Host "   App '$($a.name)' angelegt." -ForegroundColor Green
  } else {
    az containerapp update -g $ResourceGroup -n $a.name `
      --image $a.image --cpu $a.cpu --memory $a.mem `
      --min-replicas 1 --max-replicas $MaxReplicas --only-show-errors | Out-Null
    Write-Host "   App '$($a.name)' aktualisiert." -ForegroundColor Green
  }
}

Write-Host '== 4) FQDNs ==' -ForegroundColor Cyan
$kositFqdn = az containerapp show -g $ResourceGroup -n erechnung-kosit   --query properties.configuration.ingress.fqdn -o tsv
$veraFqdn  = az containerapp show -g $ResourceGroup -n erechnung-verapdf --query properties.configuration.ingress.fqdn -o tsv
if ([string]::IsNullOrWhiteSpace($kositFqdn) -or [string]::IsNullOrWhiteSpace($veraFqdn)) { Fail 'FQDN nicht ermittelbar.' }
$kositUrl = "https://$kositFqdn/"
$veraUrl  = "https://$veraFqdn/"
Write-Host "   KOSIT_DAEMON_URL = $kositUrl"
Write-Host "   VERAPDF_URL      = $veraUrl"

Write-Host '== 5) Health-Check (bis zu 90 s auf ersten Replica warten) ==' -ForegroundColor Cyan
function Wait-Health($url) {
  for ($i = 0; $i -lt 18; $i++) {
    try {
      $r = Invoke-WebRequest -Uri $url -Method GET -TimeoutSec 10 -SkipHttpErrorCheck
      if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) { return $true }
    } catch { }
    Start-Sleep -Seconds 5
  }
  return $false
}
$kOk = Wait-Health $kositUrl
$vOk = Wait-Health $veraUrl
Write-Host ("   KoSIT:  " + $(if ($kOk) { 'erreichbar' } else { 'NICHT erreichbar' })) -ForegroundColor $(if ($kOk) { 'Green' } else { 'Red' })
Write-Host ("   veraPDF:" + $(if ($vOk) { ' erreichbar' } else { ' NICHT erreichbar' })) -ForegroundColor $(if ($vOk) { 'Green' } else { 'Red' })

if (-not $SkipFunctionUpdate) {
  if ($kOk -and $vOk) {
    Write-Host '== 6) Function-App-Einstellungen umstellen ==' -ForegroundColor Cyan
    az functionapp config appsettings set -g $ResourceGroup -n $FunctionApp `
      --settings "KOSIT_DAEMON_URL=$kositUrl" "VERAPDF_URL=$veraUrl" --only-show-errors | Out-Null
    Write-Host '   Umgestellt.' -ForegroundColor Green
  } else {
    Write-Host '== 6) UEBERSPRUNGEN: Health nicht gruen -> URLs NICHT umgestellt (ACI bleibt aktiv). ==' -ForegroundColor Yellow
  }
}

Write-Host ''
Write-Host 'Fertig.' -ForegroundColor Cyan
Write-Host 'Verifizieren (Health/Info):'
Write-Host "  curl.exe -s $kositUrl"
Write-Host "  curl.exe -s $veraUrl"
Write-Host ''
Write-Host 'Wenn alles laeuft, die alten ACIs abschalten (spart die ~90 EUR/Monat):' -ForegroundColor Cyan
Write-Host "  az container delete -g $ResourceGroup -n erechnung-kosit --yes"
Write-Host "  az container delete -g $ResourceGroup -n erechnung-verapdf --yes"
Write-Host ''
Write-Host 'Rollback (falls noetig): App-Einstellungen zurueck auf die ACI-URLs:' -ForegroundColor DarkGray
Write-Host "  az functionapp config appsettings set -g $ResourceGroup -n $FunctionApp --settings ``"
Write-Host "    KOSIT_DAEMON_URL=http://erechnung-kosit.$Location.azurecontainer.io:8080/ ``"
Write-Host "    VERAPDF_URL=http://erechnung-verapdf.$Location.azurecontainer.io:8080/"
