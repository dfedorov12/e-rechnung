# Prüfdienste: von ACI (Dauerbetrieb) auf Azure Container Apps

Die Prüfdienste **KoSIT** und **veraPDF** liefen als zwei Azure Container Instances
im 24/7-Dauerbetrieb (~90 €/Monat, unabhängig vom Volumen). Sie ziehen auf
**Azure Container Apps** um: gleiche ACR-Images, aber

- **min-replicas = 1** → immer eine warme Instanz, **kein Kaltstart** im laufenden Betrieb,
- **Autoscale nach HTTP-Concurrency** → Lastspitzen (ERP-Monatslauf) werden automatisch
  auf mehrere Replicas verteilt,
- **HTTPS-Ingress** mit verwaltetem Zertifikat (statt heute offenes HTTP auf `:8080`),
- **rollierendes Patching ohne Ausfall**, kein eigener Server zu pflegen,
- ~35 €/Monat statt ~90 € — bei 10.000 Rechnungen/Monat ≈ **0,0035 €/Rechnung**.

Kapazität ist bei diesem Volumen (~333/Tag) kein Thema; entscheidend waren
Wartung, Spitzen und Kaltstart – dafür sind Container Apps die passende Form.

---

## Migration ausführen

```powershell
cd scripts
.\deploy-containerapps.ps1
```

Das Skript ist **reversibel** und geht in dieser Reihenfolge vor:

1. `az`-Erweiterung `containerapp` + Resource Provider `Microsoft.App` /
   `Microsoft.OperationalInsights` registrieren.
2. Container Apps **Environment** `erechnung-cae` anlegen.
3. Zwei Apps `erechnung-kosit` / `erechnung-verapdf` aus den ACR-Images erstellen
   (Port 8080, HTTPS-Ingress, min 1 / max 5, Skalierung ab 10 gleichzeitigen Requests).
4. FQDNs auslesen → `KOSIT_DAEMON_URL` / `VERAPDF_URL` als `https://<fqdn>/`.
5. **Health-Check** (wartet bis zu 90 s auf den ersten Replica).
6. Nur **wenn beide grün** sind: die Function-App-Einstellungen auf die neuen URLs
   umstellen. Sonst bleibt alles beim Alten (ACI aktiv).

Parameter bei Bedarf: `-MaxReplicas 10 -HttpConcurrency 20`, oder
`-SkipFunctionUpdate` (Apps bauen, URLs manuell umstellen).

---

## Nach erfolgreicher Umstellung

Erst prüfen, dass die Kette läuft (eine Rechnung über `/api/intake` bzw.
`/api/validate` schicken), dann die **alten ACIs abschalten** (das spart die Kosten):

```powershell
az container delete -g rg-erechnung-api -n erechnung-kosit --yes
az container delete -g rg-erechnung-api -n erechnung-verapdf --yes
```

**Rollback** (falls die neue Kette klemmt): Function-Einstellungen zurück auf die
ACI-URLs setzen – die ACIs laufen ja noch, solange sie nicht gelöscht sind:

```powershell
az functionapp config appsettings set -g rg-erechnung-api -n erechnung-xml2pdf --settings `
  KOSIT_DAEMON_URL=http://erechnung-kosit.germanywestcentral.azurecontainer.io:8080/ `
  VERAPDF_URL=http://erechnung-verapdf.germanywestcentral.azurecontainer.io:8080/
```

---

## Sicherheit — Stand und Härtung

**Jetzt schon besser:** Der Zugang läuft über **HTTPS** (verwaltetes Zertifikat)
statt wie bei der ACI über offenes HTTP auf Port 8080.

**Noch offen (Schritt 2, optional):** Der HTTPS-Endpunkt ist weiterhin öffentlich
erreichbar (die Dienste selbst haben keine Authentifizierung). Eine IP-Allowlist auf
die Function scheidet aus, weil Flex Consumption **keine festen Ausgangs-IPs**
liefert.

**VNet-interne Härtung — 2026-09-09 versucht und wieder zurückgebaut:** internes
Environment (`--internal-only`), interne Apps, private DNS-Zone (Wildcard `*` **und**
`*.internal` → Env-Static-IP) und Function-VNet-Integration (`snet-func`, Route-All,
`WEBSITE_DNS_SERVER=168.63.129.16`) wurden komplett provisioniert. Die internen Apps
liefen **healthy**, die Flex-Consumption-Function wurde aber nicht zum internen Ingress
geroutet → dauerhaft **HTTP 404 „Azure Container App - Unavailable"**. Bekannter
Reifegrad-Punkt von **Flex Consumption ↔ internem Container-Apps-Ingress**. Sauber
zurückgebaut (externe URLs), Funktion voll erhalten.

**Realistische Wege für echte Netz-Isolation** (falls Compliance es verlangt):
1. **Auth statt Isolation:** KoSIT ist ein Stock-Daemon (bräuchte einen Auth-Reverse-
   Proxy-Sidecar), der veraPDF-Wrapper könnte einen Header-Key selbst prüfen; oder
   Container-Apps-EasyAuth (AAD) + Managed Identity der Function.
2. **Function auf Container Apps hosten** (Functions-on-ACA) im selben internen
   Environment → nativ im VNet, erreicht die internen Apps direkt (sauberste
   Architektur, aber Re-Plattform der Function).
3. **Elastic-Premium-Function-Plan** (reife regionale VNet-Integration) — funktioniert,
   kostet aber fix (~120 €+/Monat) und hebt die Kostenersparnis auf.

> Die verarbeiteten XML/PDF enthalten Rechnungsdaten; die Dienste **speichern nichts**
> (nur Verarbeitung im Speicher). Trotzdem ist die VNet-Härtung für einen produktiven
> Dienst über alle Werke empfehlenswert.
