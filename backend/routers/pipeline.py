"""
pipeline.py - Endpoints for SLAM pipeline (config list, SVO list, start, SSE logs, ZIP download).

GET  /api/configs           - list preset YAML names
GET  /api/svos              - list SVO2 files available in data/raw/
GET  /api/status            - current state of record + pipeline processes
POST /api/pipeline/start    - launch run_pipeline.py
GET  /api/logs/pipeline     - Server-Sent Events log stream
GET  /api/download/{name}   - serve the generated ZIP for download
"""

import asyncio
import logging
import os
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional

import yaml
from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

from ..config import REPO_ROOT
from ..utils.process_manager import process_manager

logger = logging.getLogger(__name__)
router = APIRouter()


# ── Schemas ───────────────────────────────────────────────────────────────

class PipelineStartRequest(BaseModel):
    config: str = Field(..., description="Preset name (stem), e.g. outdoor")
    svo_stem: str = Field(..., description="SVO2 file stem (without extension), e.g. outdoor_10")
    output_name: str = Field(
        default="",
        description="Output folder name (defaults to svo_stem if empty)",
    )
    map_choice: int = Field(
        default=1, ge=1, le=2,
        description="Map to include in ZIP: 1=RTAB-Map built-in, 2=manual projection",
    )
    extra_args: list[str] = Field(
        default_factory=list,
        description="CLI args forwarded verbatim to run_pipeline.py (overrides YAML values)",
    )


# ── Endpoints ─────────────────────────────────────────────────────────────

@router.get("/configs", summary="List available preset configs")
async def list_configs():
    presets_dir = REPO_ROOT / "config" / "presets"
    if not presets_dir.is_dir():
        return {"configs": []}
    names = sorted(p.stem for p in presets_dir.glob("*.yaml"))
    return {"configs": names}


@router.get("/svos", summary="List SVO2 files available for processing")
async def list_svos():
    raw_dir = REPO_ROOT / "data" / "raw"
    if not raw_dir.is_dir():
        return {"svos": []}
    files = []
    for p in sorted(raw_dir.glob("*.svo2"), key=lambda x: x.name):
        mtime = datetime.fromtimestamp(os.path.getmtime(p))
        files.append({"name": p.stem, "date": mtime.strftime("%Y-%m-%d %H:%M")})
    return {"svos": files}


@router.get("/svos/exists", summary="Check if an SVO2 filename already exists")
async def svo_exists(name: str):
    """Return whether an SVO2 with this stem already exists in data/raw/."""
    if any(c in name for c in ("/", "\\", "..")):
        raise HTTPException(400, "Invalid name")
    dest = REPO_ROOT / "data" / "raw" / f"{name}.svo2"
    return {"exists": dest.is_file(), "name": name}


@router.post("/svos/upload", summary="Upload an SVO2 file")
async def upload_svo(file: UploadFile = File(...), name: str = ""):
    """Save an uploaded .svo2 file to data/raw/.
    If `name` is provided, use it as the stem (without .svo2 extension)."""
    if not file.filename or not file.filename.lower().endswith(".svo2"):
        raise HTTPException(400, "Only .svo2 files are accepted")

    raw_dir = REPO_ROOT / "data" / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)

    # Use provided name stem, otherwise derive from uploaded filename
    if name:
        safe_name = f"{name}.svo2"
    else:
        safe_name = Path(file.filename).name
    dest = raw_dir / safe_name

    try:
        with open(dest, "wb") as f:
            while chunk := await file.read(1024 * 1024):  # 1 MB chunks
                f.write(chunk)
    except Exception as e:
        if dest.exists():
            dest.unlink()
        raise HTTPException(500, f"Failed to save file: {e}")

    logger.info("Uploaded SVO2: %s (%d bytes)", safe_name, dest.stat().st_size)
    return {"name": dest.stem, "status": "ok"}


@router.get("/presets/{name}", summary="Get editable parameters for a preset")
async def get_preset_params(name: str):
    if any(c in name for c in ("/", "\\", "..")):
        raise HTTPException(400, "Invalid preset name")
    preset_path = REPO_ROOT / "config" / "presets" / f"{name}.yaml"
    if not preset_path.is_file():
        raise HTTPException(404, f"Preset not found: {name}")

    with open(preset_path) as f:
        raw = yaml.safe_load(f)

    # Ordered param definitions: (yaml_key, cli_arg, type, label)
    # type is one of: float | int | str | bool | choice:a,b,c
    KNOWN = [
        ("min_z",             "--min-z",             "float",                   "min_z (min height, m)"),
        ("max_z",             "--max-z",             "float",                   "max_z (max height, m)"),
        ("resolution",        "--resolution",        "float",                   "resolution (cell size, m/px)"),
        ("side",              "--side",              "choice:left,right",       "side (camera side)"),
        ("depth_scale",       "--depth-scale",       "float",                   "depth_scale (scale factor for depth images)"),
        ("depth_compression", "--depth-compression", "int",                     "depth_compression (PNG level 0-9)"),
        ("render",            "--render",            "choice:cloud,mesh,texture","render (3D export mode)"),
        ("superpoint",        "--superpoint",        "bool",                    "superpoint (SuperPoint features)"),
        ("quality",           "--quality",           "int",                     "quality (ZED depth mode)"),
        ("trim_start",        "--trim-start",        "float",                   "trim_start (skip start, s)"),
        ("trim_end",          "--trim-end",          "float",                   "trim_end (skip end, s)"),
        ("regen_grid",        "--regen-grid",        "bool",                    "regen_grid (rebuild grid only)"),
    ]

    params = []
    for yaml_key, cli, type_, label in KNOWN:
        if yaml_key in raw:
            v = raw[yaml_key]
            params.append({
                "key": yaml_key,
                "cli": cli,
                "type": type_,
                "label": label,
                "value": str(v).lower() if isinstance(v, bool) else str(v),
            })

    # RTAB-Map params (dynamic — whatever is in the rtabmap: block)
    for k, v in raw.get("rtabmap", {}).items():
        t = "float" if isinstance(v, float) else "int" if isinstance(v, int) else "str"
        params.append({
            "key": f"rtabmap.{k}",
            "cli": f"--{k}",
            "type": t,
            "label": k,
            "value": str(v),
        })

    return {"params": params}


# ── Preset helpers ───────────────────────────────────────────────────────

_SAFE_PRESET_NAME = re.compile(r'^[A-Za-z0-9_\-]+$')
_PARAM_TYPES: dict[str, type] = {
    "min_z": float, "max_z": float, "resolution": float,
    "depth_scale": float, "trim_start": float, "trim_end": float,
    "depth_compression": int, "quality": int,
}
_PARAM_BOOLS = {"superpoint", "regen_grid"}


class PresetBase(BaseModel):
    values: dict[str, str] = Field(default_factory=dict)
    rtabmap: dict[str, str] = Field(default_factory=dict)


class PresetCreateRequest(PresetBase):
    name: str


class PresetUpdateRequest(PresetBase):
    pass


def _build_preset_data(payload: PresetBase) -> dict:
    """Convert string-valued frontend payload into a typed YAML-ready dict."""
    data: dict = {}

    for k, v in payload.values.items():
        if not k.strip():
            continue
        if k in _PARAM_BOOLS:
            data[k] = (v == "true")
        elif k in _PARAM_TYPES:
            try:
                data[k] = _PARAM_TYPES[k](v)
            except (ValueError, TypeError):
                data[k] = v
        else:
            data[k] = v

    if payload.rtabmap:
        rtab: dict = {}
        for k, v in payload.rtabmap.items():
            if not k.strip():
                continue
            try:
                rtab[k] = int(v)
            except ValueError:
                try:
                    rtab[k] = float(v)
                except ValueError:
                    rtab[k] = v
        if rtab:
            data["rtabmap"] = rtab

    return data


def _save_preset_to_disk(preset_path: Path, payload: PresetBase) -> None:
    """Write a preset YAML file from a validated payload."""
    data = _build_preset_data(payload)
    preset_path.parent.mkdir(parents=True, exist_ok=True)
    with open(preset_path, "w") as f:
        yaml.dump(data, f, default_flow_style=False, allow_unicode=True, sort_keys=False)


@router.post("/presets", summary="Create a new preset YAML", status_code=201)
async def create_preset(body: PresetCreateRequest):
    if not _SAFE_PRESET_NAME.match(body.name):
        raise HTTPException(400, "Invalid preset name (alphanumeric, underscores and hyphens only)")
    preset_path = REPO_ROOT / "config" / "presets" / f"{body.name}.yaml"
    if preset_path.is_file():
        raise HTTPException(409, f"Preset '{body.name}' already exists")
    _save_preset_to_disk(preset_path, body)
    return {"status": "created", "name": body.name}


@router.put("/presets/{name}", summary="Update an existing preset YAML")
async def update_preset(name: str, body: PresetUpdateRequest):
    if not _SAFE_PRESET_NAME.match(name):
        raise HTTPException(400, "Invalid preset name")
    preset_path = REPO_ROOT / "config" / "presets" / f"{name}.yaml"
    if not preset_path.is_file():
        raise HTTPException(404, f"Preset not found: {name}")
    _save_preset_to_disk(preset_path, body)
    return {"status": "updated", "name": name}


@router.delete("/presets/{name}", summary="Delete a preset YAML")
async def delete_preset(name: str):
    if not _SAFE_PRESET_NAME.match(name):
        raise HTTPException(400, "Invalid preset name")
    preset_path = REPO_ROOT / "config" / "presets" / f"{name}.yaml"
    if not preset_path.is_file():
        raise HTTPException(404, f"Preset not found: {name}")
    preset_path.unlink()
    return {"status": "deleted", "name": name}


@router.get("/status", summary="Current process states")
async def get_status():
    return {
        "record": process_manager.status("record").value,
        "pipeline": process_manager.status("pipeline").value,
    }


@router.post("/pipeline/start", summary="Launch SLAM pipeline")
async def start_pipeline(body: PipelineStartRequest):
    if process_manager.is_running("pipeline"):
        raise HTTPException(409, "Pipeline already running")

    config_path = REPO_ROOT / "config" / "presets" / f"{body.config}.yaml"
    if not config_path.is_file():
        raise HTTPException(404, f"Preset not found: {body.config}")

    svo_path = REPO_ROOT / "data" / "raw" / f"{body.svo_stem}.svo2"
    if not svo_path.is_file():
        raise HTTPException(404, f"SVO2 not found: {body.svo_stem}.svo2")

    output_dir = body.output_name if body.output_name else body.svo_stem
    if any(c in output_dir for c in ("/", "\\", "..")):
        raise HTTPException(400, "Invalid output folder name: path traversal detected.")

    cmd: list[str] = [
        sys.executable, "-u",
        str(REPO_ROOT / "src" / "run_pipeline.py"),
        "--config", str(config_path),
        "--svo", str(svo_path),
        "--output", str(REPO_ROOT / "data" / "outputs" / output_dir),
        "--map-choice", str(body.map_choice),
    ]

    # All param overrides arrive as pre-built CLI args
    cmd += body.extra_args

    loop = asyncio.get_running_loop()
    process_manager.start("pipeline", cmd, str(REPO_ROOT), loop)
    logger.info("Pipeline started: preset=%s svo=%s output=%s", body.config, body.svo_stem, output_dir)
    return {"status": "started", "svo": body.svo_stem, "output": output_dir}


@router.post("/pipeline/stop", summary="Kill the running pipeline")
async def stop_pipeline():
    if not process_manager.is_running("pipeline"):
        raise HTTPException(409, "Pipeline is not running")
    process_manager.stop("pipeline")
    return {"status": "stopping"}


@router.get("/logs/pipeline", summary="SSE log stream for pipeline")
async def stream_pipeline_logs():
    mp = process_manager.get("pipeline")

    async def generator():
        if mp is None:
            yield "data: [INFO] No pipeline process found.\n\n"
            return
        try:
            while True:
                try:
                    msg: str = await asyncio.wait_for(mp.log_queue.get(), timeout=15.0)
                    if msg.startswith("__EXIT__"):
                        rc = int(msg[8:])
                        yield f"data: [DONE] exit={rc}\n\n"
                        break
                    yield f"data: {msg}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        except asyncio.CancelledError:
            pass

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@router.get("/download/{session_name}", summary="Download generated ZIP")
async def download_zip(session_name: str):
    # Basic path traversal protection
    if any(c in session_name for c in ("/", "\\", "..")):
        raise HTTPException(400, "Invalid session name")

    zip_path: Path = (
        REPO_ROOT / "data" / "outputs" / session_name / f"{session_name}.zip"
    )
    if not zip_path.is_file():
        raise HTTPException(404, f"ZIP not found for session: {session_name}")

    return FileResponse(
        path=str(zip_path),
        filename=f"{session_name}.zip",
        media_type="application/zip",
    )
