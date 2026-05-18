"""
downloads.py – Endpoints for browsing and downloading session files.

GET  /api/sessions                  – list all sessions (union of raw + outputs)
GET  /api/sessions/{name}/files     – list files for a session
POST /api/sessions/download         – zip selected files and stream back
"""

import logging
import re
import tempfile
import zipfile
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

from ..config import REPO_ROOT

logger = logging.getLogger(__name__)
router = APIRouter()

_SAFE_NAME = re.compile(r'^[A-Za-z0-9_\- ]+$')
_RAW_DIR = REPO_ROOT / "data" / "raw"
_OUTPUTS_DIR = REPO_ROOT / "data" / "outputs"
_DATA_DIR = REPO_ROOT / "data"


def _human_size(n: int) -> str:
    for unit in ('B', 'KB', 'MB', 'GB'):
        if n < 1024:
            return f"{n:.0f} {unit}"
        n /= 1024  # type: ignore[assignment]
    return f"{n:.1f} GB"


@router.get("/sessions", summary="List all sessions")
async def list_sessions():
    entries: dict[str, datetime] = {}
    if _RAW_DIR.is_dir():
        for p in _RAW_DIR.glob("*.svo2"):
            mtime = datetime.fromtimestamp(p.stat().st_mtime)
            if p.stem not in entries or mtime > entries[p.stem]:
                entries[p.stem] = mtime
    if _OUTPUTS_DIR.is_dir():
        for p in _OUTPUTS_DIR.iterdir():
            if p.is_dir():
                mtime = datetime.fromtimestamp(p.stat().st_mtime)
                if p.name not in entries or mtime > entries[p.name]:
                    entries[p.name] = mtime
    sessions = [
        {"name": name, "date": entries[name].strftime("%Y-%m-%d %H:%M")}
        for name in sorted(entries)
    ]
    return {"sessions": sessions}


@router.get("/sessions/{name}/files", summary="List files for a session")
async def list_session_files(name: str):
    if not _SAFE_NAME.match(name):
        raise HTTPException(400, "Invalid session name")

    files = []

    # Raw files: .svo2, .webm, .ogg
    if _RAW_DIR.is_dir():
        for suffix in ('.svo2', '.webm', '.ogg'):
            p = _RAW_DIR / f"{name}{suffix}"
            if p.is_file():
                st = p.stat()
                files.append({
                    "path": str(p),
                    "label": p.name,
                    "size": st.st_size,
                    "size_human": _human_size(st.st_size),
                    "group": "raw",
                })

    # Output files: top-level files individually, subdirectories as a single entry
    out_dir = _OUTPUTS_DIR / name
    if out_dir.is_dir():
        for child in sorted(out_dir.iterdir()):
            if child.is_file():
                st = child.stat()
                files.append({
                    "path": str(child),
                    "label": child.name,
                    "size": st.st_size,
                    "size_human": _human_size(st.st_size),
                    "group": "output",
                    "is_dir": False,
                })
            elif child.is_dir():
                # Collect all files in the subdirectory recursively
                sub_files = sorted(child.rglob("*"))
                sub_file_paths = [p for p in sub_files if p.is_file()]
                total_size = sum(p.stat().st_size for p in sub_file_paths)
                count = len(sub_file_paths)
                if count == 0:
                    continue
                files.append({
                    "path": str(child),  # directory path sent as a unit
                    "label": f"{child.name}/ ({count} fichiers)",
                    "size": total_size,
                    "size_human": _human_size(total_size),
                    "group": "output",
                    "is_dir": True,
                })

    return {"files": files}


class DownloadRequest(BaseModel):
    session: str
    paths: list[str]


@router.post("/sessions/download", summary="Zip selected files and download")
async def download_selected(body: DownloadRequest):
    if not _SAFE_NAME.match(body.session):
        raise HTTPException(400, "Invalid session name")

    if not body.paths:
        raise HTTPException(400, "No files selected")

    # Validate all paths are strictly under allowed directories
    allowed_prefixes = (
        str(_RAW_DIR.resolve()) + "/",
        str((_OUTPUTS_DIR / body.session).resolve()) + "/",
    )

    resolved: list[Path] = []
    for raw_path in body.paths:
        try:
            p = Path(raw_path).resolve()
        except Exception:
            raise HTTPException(400, f"Invalid path: {raw_path}")
        # Must start with one of the allowed prefixes (prevents path traversal)
        if not any(str(p).startswith(pfx) for pfx in allowed_prefixes):
            raise HTTPException(400, f"Path not allowed: {raw_path}")
        if not p.exists():
            raise HTTPException(404, f"Not found: {raw_path}")
        resolved.append(p)

    # Build ZIP in a temp file
    tmp = tempfile.NamedTemporaryFile(suffix='.zip', delete=False)
    tmp.close()
    tmp_path = Path(tmp.name)

    try:
        with zipfile.ZipFile(tmp.name, 'w', zipfile.ZIP_DEFLATED, compresslevel=1) as zf:
            for p in resolved:
                if p.is_dir():
                    for sub in sorted(p.rglob("*")):
                        if sub.is_file():
                            try:
                                arcname = sub.relative_to(_DATA_DIR)
                            except ValueError:
                                arcname = Path(p.name) / sub.relative_to(p)
                            zf.write(str(sub), str(arcname))
                else:
                    try:
                        arcname = p.relative_to(_DATA_DIR)
                    except ValueError:
                        arcname = Path(p.name)
                    zf.write(str(p), str(arcname))
    except Exception as exc:
        tmp_path.unlink(missing_ok=True)
        logger.exception("ZIP creation failed")
        raise HTTPException(500, f"ZIP creation failed: {exc}") from exc

    logger.info("ZIP ready: %s (%d files)", tmp_path, len(resolved))
    return FileResponse(
        path=str(tmp_path),
        filename=f"{body.session}.zip",
        media_type="application/zip",
        background=BackgroundTask(tmp_path.unlink, missing_ok=True),
    )
