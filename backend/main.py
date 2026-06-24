"""
main.py – FastAPI application entry point.

Start the server (from repo root):

    # HTTP (no microphone support):
    uvicorn backend.main:app --host 0.0.0.0 --port 8080 --reload

    # HTTPS (required for browser microphone access):
    uvicorn backend.main:app --host 0.0.0.0 --port 8080 \\
        --ssl-keyfile key.pem --ssl-certfile cert.pem

    # Or simply:
    python -m backend.main          # auto-detects SSL cert/key

In development, run the React dev server separately (cd frontend && npm run dev),
which proxies /api to localhost:8080.

For production, build the frontend first (cd frontend && npm run build), which
writes static assets to backend/static/.  The app will then serve the SPA
from that directory.
"""

import logging
import os
import sys
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from .routers import audio, capture, downloads, pipeline

# ── Logging ───────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger(__name__)

# ── App ───────────────────────────────────────────────────────────────────

app = FastAPI(
    title="Vista Capture App",
    version="1.0.0",
    description="Web interface for controlling ZED2i SVO recording and RTAB-Map pipeline.",
)

# API routers (must be included before static-file fallback mount)
app.include_router(audio.router, prefix="/api", tags=["audio"])
app.include_router(capture.router, prefix="/api", tags=["capture"])
app.include_router(downloads.router, prefix="/api", tags=["downloads"])
app.include_router(pipeline.router, prefix="/api", tags=["pipeline"])

# ── Static files (built React SPA) ────────────────────────────────────────

_static_dir = Path(__file__).parent / "static"

if _static_dir.is_dir():
    app.mount("/", StaticFiles(directory=str(_static_dir), html=True), name="static")
    logger.info("Serving frontend from: %s", _static_dir)
else:
    # Minimal placeholder so the server is still usable before a frontend build
    logger.warning(
        "Frontend static dir not found (%s). Run: cd frontend && npm run build",
        _static_dir,
    )

    @app.get("/", response_class=HTMLResponse, include_in_schema=False)
    async def _index():
        return (
            "<html><body>"
            "<h2>Vista Capture App – backend running</h2>"
            "<p>Build the frontend first: <code>cd frontend &amp;&amp; npm run build</code></p>"
            "<p>API docs: <a href='/docs'>/docs</a></p>"
            "</body></html>"
        )

# ── Direct execution (python -m backend.main) ─────────────────────────────

if __name__ == "__main__":
    import argparse as _argparse

    _parser = _argparse.ArgumentParser(description="Vista Capture App server")
    _parser.add_argument("--host", "--hostname", dest="hostname",
                         default=os.environ.get("HOST", "0.0.0.0"),
                         help="Bind address (default: 0.0.0.0, or $HOST)")
    _parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8080")),
                         help="Bind port (default: 8080, or $PORT)")
    _parser.add_argument("--no-ssl", action="store_true",
                         help="Force HTTP even if cert.pem/key.pem are present")
    _cli = _parser.parse_args()

    repo_root = Path(__file__).resolve().parent.parent
    host = _cli.hostname
    port = _cli.port

    cert_file = repo_root / "cert.pem"
    key_file = repo_root / "key.pem"

    ssl_kwargs: dict = {}
    if not _cli.no_ssl and cert_file.is_file() and key_file.is_file():
        ssl_kwargs = {
            "ssl_certfile": str(cert_file),
            "ssl_keyfile": str(key_file),
        }
        logger.info("SSL enabled – HTTPS on https://%s:%s", host, port)
    else:
        reason = "(--no-ssl)" if _cli.no_ssl else f"(files missing: {cert_file} / {key_file})"
        logger.warning(
            "SSL disabled %s. Serving HTTP only – browser microphone access will be blocked.",
            reason,
        )

    logger.info("Starting server on %s:%s ...", host, port)
    uvicorn.run(
        "backend.main:app",
        host=host,
        port=port,
        reload=False,  # never reload in production / systemd
        **ssl_kwargs,
    )
