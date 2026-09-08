# veraPDF (PDF/A-3b) als HTTP-Dienst. Node-Wrapper ruft die veraPDF-CLI (Java) auf.
#
# Build:  az acr build -r <registry> -t erechnung-verapdf:latest .
#         (oder lokal: docker build -t erechnung-verapdf .)
# Test:   curl -X POST --data-binary @rechnung.pdf http://localhost:8080/
FROM node:20-bookworm-slim

ARG VERAPDF_VER=1.26.2
ARG VERAPDF_REL=1.26

RUN apt-get update \
 && apt-get install -y --no-install-recommends default-jre-headless curl unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt

COPY auto-install.xml /opt/auto-install.xml

# veraPDF Greenfield per Installer (headless / auto-install) installieren.
RUN curl -sSL -o verapdf.zip "https://software.verapdf.org/rel/${VERAPDF_REL}/verapdf-greenfield-${VERAPDF_VER}-installer.zip" \
 && unzip -q verapdf.zip -d verapdf-inst \
 && INSTALLER="$(find verapdf-inst -name 'verapdf-*installer*.jar' | head -1)" \
 && java -jar "$INSTALLER" /opt/auto-install.xml \
 && rm -rf verapdf.zip verapdf-inst \
 && test -x /opt/verapdf/verapdf

COPY server.js /opt/server.js

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD curl -fsS http://localhost:8080/ >/dev/null || exit 1

CMD ["node", "/opt/server.js"]
