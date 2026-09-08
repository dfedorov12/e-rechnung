# KoSIT-Validator im Daemon-Modus (HTTP) — offizieller Validator, Java 8.
# Baut die XRechnung-Konfiguration (release 2024-06-20, 3.0.2) fest ein.
#
# Build:  docker build -t erechnung-kosit .
# Run:    docker run -p 8080:8080 erechnung-kosit
# Test:   curl -X POST --data-binary @rechnung.xml http://localhost:8080/
FROM eclipse-temurin:8-jre

ARG KOSIT_VER=1.5.0
ARG CONFIG_URL=https://github.com/itplr-kosit/validator-configuration-xrechnung/releases/download/release-2024-06-20/validator-configuration-xrechnung_3.0.2_2024-06-20.zip

WORKDIR /opt/kosit

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && curl -sSL -o validator.zip "https://github.com/itplr-kosit/validator/releases/download/v${KOSIT_VER}/validator-${KOSIT_VER}-distribution.zip" \
 && mkdir validator && unzip -q validator.zip -d validator && rm validator.zip \
 && curl -sSL -o config.zip "${CONFIG_URL}" \
 && mkdir config && unzip -q config.zip -d config && rm config.zip

COPY entrypoint.sh /opt/kosit/entrypoint.sh
RUN chmod +x /opt/kosit/entrypoint.sh

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s \
  CMD curl -fsS http://localhost:8080/ >/dev/null || exit 1

ENTRYPOINT ["/opt/kosit/entrypoint.sh"]
