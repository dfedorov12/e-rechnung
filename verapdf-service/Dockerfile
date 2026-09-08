# veraPDF (PDF/A-3b) als HTTP-Dienst. Node-Wrapper ruft die veraPDF-CLI (Java) auf.
#
# Basis: eclipse-temurin (Java fertig eingebaut, KEIN debian ca-certificates-java).
# Node kommt via apt (dpkg) — das Tarball-Entpacken schlaegt in der ACR-Build-
# Sandbox mit "tar: Function not implemented" fehl.
#
# Build:  az acr build -r <registry> -t erechnung-verapdf:latest .
FROM eclipse-temurin:17-jre

ARG VERAPDF_VER=1.26.2
ARG VERAPDF_REL=1.26

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl unzip nodejs \
 && rm -rf /var/lib/apt/lists/* \
 && (command -v node >/dev/null 2>&1 || ln -s "$(command -v nodejs)" /usr/local/bin/node) \
 && node --version

WORKDIR /opt
COPY auto-install.xml /opt/auto-install.xml

# veraPDF Greenfield headless installieren.
RUN curl -fsSL -o verapdf.zip "https://software.verapdf.org/rel/${VERAPDF_REL}/verapdf-greenfield-${VERAPDF_VER}-installer.zip" \
 && unzip -q verapdf.zip -d verapdf-inst \
 && INSTALLER="$(find verapdf-inst -name 'verapdf-*installer*.jar' | head -1)" \
 && java -jar "$INSTALLER" /opt/auto-install.xml \
 && rm -rf verapdf.zip verapdf-inst \
 && chmod +x /opt/verapdf/verapdf \
 && /opt/verapdf/verapdf --version

COPY server.js /opt/server.js

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD curl -fsS http://localhost:8080/ >/dev/null || exit 1

CMD ["node", "/opt/server.js"]
