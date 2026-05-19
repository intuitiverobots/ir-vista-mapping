"""
audio.py – Endpoint for receiving the browser-recorded audio track.

POST /api/record/audio  – accept a WebM/OGG blob and save it alongside the SVO2 file
"""

import logging
import re
from pathlib import Path

from fastapi import APIRouter, Form, HTTPException, UploadFile

from ..config import REPO_ROOT

logger = logging.getLogger(__name__)
router = APIRouter()

# Only allow safe characters in the session name (same rule as output_name)
_SAFE_NAME = re.compile(r'^[A-Za-z0-9_\- ]+$')


@router.post("/record/audio", summary="Upload browser-recorded audio for a session")
async def upload_audio(
    file: UploadFile,
    session_name: str = Form(..., description="Session name (stem of the .svo2 file)"),
):
    """Save the uploaded audio blob next to the corresponding .svo2 file."""
    # Validate session name to prevent path traversal
    if not _SAFE_NAME.match(session_name):
        raise HTTPException(
            status_code=400,
            detail="Invalid session_name: only alphanumeric characters, hyphens, and underscores are allowed.",
        )

    raw_dir: Path = REPO_ROOT / "data" / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)

    # Derive file extension from the uploaded content-type, fall back to .webm
    content_type: str = file.content_type or "audio/webm"
    ext = ".ogg" if "ogg" in content_type else ".webm"
    dest = raw_dir / f"{session_name}{ext}"

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Uploaded audio file is empty.")

    dest.write_bytes(content)
    logger.info("Audio saved → %s (%d bytes)", dest, len(content))
    return {"status": "saved", "path": str(dest), "size": len(content)}
