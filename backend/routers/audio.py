"""
audio.py – Endpoint for receiving browser-recorded audio tracks.

POST /api/record/audio  – accept a WebM/OGG blob and save it alongside the SVO2 file.
                         Supports both continuous single-track and segmented
                         (push-to-talk / start-stop) audio with timing metadata.

Segment files are stored in  data/raw/<session>_audio/  alongside a manifest.json
that maps each segment to its video-timeline offset.
"""

import json
import logging
import re
from pathlib import Path

from fastapi import APIRouter, Form, HTTPException, UploadFile

from ..config import REPO_ROOT

logger = logging.getLogger(__name__)
router = APIRouter()

# Only allow safe characters in the session name (same rule as output_name)
_SAFE_NAME = re.compile(r'^[A-Za-z0-9_\- ]+$')

_MANIFEST_FILENAME = "manifest.json"


def _read_manifest(manifest_path: Path) -> dict:
    """Read existing manifest or return empty template."""
    if manifest_path.is_file():
        try:
            return json.loads(manifest_path.read_text())
        except (json.JSONDecodeError, OSError):
            logger.warning("Corrupt manifest at %s – resetting.", manifest_path)
    return {"segments": []}


def _write_manifest(manifest_path: Path, manifest: dict) -> None:
    manifest_path.write_text(json.dumps(manifest, indent=2))


@router.post("/record/audio", summary="Upload browser-recorded audio for a session")
async def upload_audio(
    file: UploadFile,
    session_name: str = Form(..., description="Session name (stem of the .svo2 file)"),
    start_time: float = Form(default=0.0, description="Segment start offset from video start (seconds)"),
    end_time: float = Form(default=0.0, description="Segment end offset from video start (seconds)"),
    segment_index: int = Form(default=0, description="Zero-based index of this audio segment"),
    audio_mode: str = Form(default="continuous", description="Recording mode: continuous, push-to-talk, or start-stop"),
):
    """Save the uploaded audio blob alongside the corresponding .svo2 file.

    For continuous recording: start_time=0, end_time=total_elapsed, segment_index=0.
    For push-to-talk / start-stop: each segment carries its own timing.
    """
    # Validate session name to prevent path traversal
    if not _SAFE_NAME.match(session_name):
        raise HTTPException(
            status_code=400,
            detail="Invalid session_name: only alphanumeric characters, hyphens, and underscores are allowed.",
        )

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Uploaded audio file is empty.")

    # Derive file extension from the uploaded content-type, fall back to .webm
    content_type: str = file.content_type or "audio/webm"
    ext = ".ogg" if "ogg" in content_type else ".webm"

    # Store segments in a dedicated directory: data/raw/<session>_audio/
    audio_dir: Path = REPO_ROOT / "data" / "raw" / f"{session_name}_audio"
    audio_dir.mkdir(parents=True, exist_ok=True)

    segment_filename = f"seg{segment_index:03d}{ext}"
    segment_path = audio_dir / segment_filename
    segment_path.write_bytes(content)

    # Update manifest
    manifest_path = audio_dir / _MANIFEST_FILENAME
    manifest = _read_manifest(manifest_path)

    # Store the audio recording mode at the top level (used by svo_export.py
    # to choose the correct mux strategy)
    manifest["audio_mode"] = audio_mode

    # Replace if a segment with the same index already exists (re-upload / overwrite)
    manifest["segments"] = [s for s in manifest["segments"] if s["index"] != segment_index]
    manifest["segments"].append({
        "index": segment_index,
        "file": segment_filename,
        "start_time": start_time,
        "end_time": end_time,
    })
    # Keep segments sorted by index
    manifest["segments"].sort(key=lambda s: s["index"])

    _write_manifest(manifest_path, manifest)

    logger.info(
        "Audio segment saved → %s  [%.1f–%.1fs]  mode=%s  (%d bytes)",
        segment_path, start_time, end_time, audio_mode, len(content),
    )
    return {
        "status": "saved",
        "path": str(segment_path),
        "size": len(content),
        "segment_index": segment_index,
        "start_time": start_time,
        "end_time": end_time,
    }
