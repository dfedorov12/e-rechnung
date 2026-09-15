# Mustangproject-Validierung als Dienst (HTTP).
# Validiert ZUGFeRD/Factur-X gegen das TATSAECHLICHE Profil (BASIC / EN16931 /
# EXTENDED) und die PDF/A-Huelle — anders als KoSIT, das EXTENDED an der strengen
# EN16931/XRechnung-Bindung misst und dadurch zulaessige Zusatzangaben als Fehler
# meldet. XRechnung-XML laeuft weiterhin ueber den KoSIT-Dienst.
#
# Build:  docker build -t erechnung-mustang .
# Run:    docker run -p 8080:8080 erechnung-mustang
# Test:   curl -X POST --data-binary @rechnung.pdf http://localhost:8080/
#
# Java 17: Mustangproject 2.x setzt >= Java 11 voraus (Java 8 -> UnsupportedClass-
# VersionError). Der KoSIT-Dienst bleibt davon unberuehrt (laeuft weiter auf Java 8).
FROM eclipse-temurin:17-jre

ARG MUSTANG_VER=2.16.0
WORKDIR /opt/mustang

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates python3 \
 && rm -rf /var/lib/apt/lists/* \
 && curl -sSL -o Mustang-CLI.jar \
      "https://github.com/ZUGFeRD/mustangproject/releases/download/core-${MUSTANG_VER}/Mustang-CLI-${MUSTANG_VER}.jar"

COPY server.py /opt/mustang/server.py

ENV MUSTANG_JAR=/opt/mustang/Mustang-CLI.jar
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD curl -fsS http://localhost:8080/ >/dev/null || exit 1

ENTRYPOINT ["python3", "/opt/mustang/server.py"]
