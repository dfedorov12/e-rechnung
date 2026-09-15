#!/usr/bin/env python3
"""Schlanker HTTP-Wrapper um Mustang-CLI.

POST /  (Body = ZUGFeRD/Factur-X-PDF ODER CII-XML)  -> Mustang-Validierungsreport (roh)
GET  /                                              -> Health-JSON

Der aufrufende Azure-Function-Wrapper (api/src/mustang.js) wertet den Report aus.
Es wird bewusst der ROHE Mustang-Report zurueckgegeben (kein Umbau hier), damit die
Auswertung an einer Stelle (mustang.js) liegt und revisionssicher archivierbar bleibt.
"""
import os
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer

JAR = os.environ.get("MUSTANG_JAR", "/opt/mustang/Mustang-CLI.jar")


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/xml; charset=utf-8"):
        b = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        self._send(200, '{"service":"Mustang-Validierung","status":"ok"}',
                   "application/json; charset=utf-8")

    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0") or 0)
        data = self.rfile.read(n) if n else b""
        if not data:
            return self._send(400, "<error>leerer Body</error>")
        # PDF (ZUGFeRD/Factur-X) an Magic-Bytes erkennen, sonst als XML behandeln.
        ext = ".pdf" if data[:5] == b"%PDF-" else ".xml"
        path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as f:
                f.write(data)
                path = f.name
            r = subprocess.run(
                ["java", "-jar", JAR, "--action", "validate", "--source", path],
                capture_output=True, timeout=180)
            report = (r.stdout.decode("utf-8", "replace").strip()
                      or r.stderr.decode("utf-8", "replace").strip())
        except subprocess.TimeoutExpired:
            return self._send(504, "<error>Mustang-Timeout</error>")
        except Exception as e:  # noqa: BLE001 - Fehler als Report zurueckgeben
            return self._send(500, "<error>%s</error>" % str(e))
        finally:
            if path:
                try:
                    os.unlink(path)
                except OSError:
                    pass
        self._send(200, report or "<error>kein Report</error>")

    def log_message(self, *args):  # Zugriffslog unterdruecken
        pass


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
