#!/usr/bin/env bash
# Startet den KoSIT-Validator im Daemon-Modus auf 0.0.0.0:8080.
set -euo pipefail

JAR="$(find /opt/kosit/validator -name 'validationtool-*-standalone.jar' | sort | head -1)"
SCEN="$(find /opt/kosit/config -name 'scenarios.xml' | head -1)"
REPO="$(dirname "$SCEN")"

if [ -z "$JAR" ] || [ -z "$SCEN" ]; then
  echo "FEHLER: Validator-JAR oder scenarios.xml nicht gefunden." >&2
  exit 1
fi

echo "KoSIT-Daemon startet:"
echo "  JAR:        $JAR"
echo "  Szenarien:  $SCEN"
echo "  Repository: $REPO"

# -D Daemon, -H Host, -P Port, -s Szenarien, -r Ressourcen-Verzeichnis
exec java -jar "$JAR" -s "$SCEN" -r "$REPO" -D -H 0.0.0.0 -P 8080
