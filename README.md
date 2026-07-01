# Vista Capture App

> A headless web application for field mapping with the ZED 2i camera on NVIDIA Jetson Orin.
> Control capture and SLAM processing from any smartphone — no screen, no keyboard, no SSH required.

---

## Overview

**Vista Capture App** is a local web interface that runs natively on a Jetson Orin. On the field, the operator connects to the Jetson's Wi-Fi hotspot and opens the app in a mobile browser to:

- **Record** stereo video from the ZED 2i camera into `.svo2` files.
- **Process** recordings through a modular 6-step SLAM pipeline (RTAB-Map) and download the results as a ZIP archive.

All pipeline logs stream in real time to the browser via Server-Sent Events (SSE). The entire UI fits comfortably on a smartphone screen.

---

## Architecture & Technologies

### Backend — runs natively on the Jetson host OS

The backend is a **FastAPI** application executed directly on the host (not inside Docker). This is intentional: the ZED SDK requires direct access to USB/CSI hardware and GPU drivers that are unavailable inside a standard container.

| Component | Details |
|---|---|
| Runtime | Python 3.10, Uvicorn |
| Framework | FastAPI |
| ZED SDK | Accessed natively via `pyzed` |
| Capture | `src/svo_recording.py` — SIGINT-safe SVO2 recording |
| Pipeline orchestration | `src/run_pipeline.py` — 6-step sequential/parallel runner |

### SLAM — runs inside Docker

RTAB-Map is built from source inside a custom ARM64 Docker image (`rtabmap_standalone`) that bundles ZED SDK + RTAB-Map 0.21.4. Pipeline scripts launch and monitor this container programmatically, streaming its stdout line-by-line to the UI.

```
src/process_svo.py  →  docker run rtabmap_standalone  →  rtabmap.db / map.pgm / cloud.ply
```

The Docker image is based on the Stereolabs Jetson image:
```dockerfile
FROM stereolabs/zed:5.2-tools-devel-l4t-r36.4
```

> The `tools-devel` L4T variant is the correct Jetson-native dev image for JetPack 6.1 (L4T r36.4).
> Check available tags at [hub.docker.com/r/stereolabs/zed/tags](https://hub.docker.com/r/stereolabs/zed/tags).

### Frontend — static SPA served by FastAPI

| Component | Details |
|---|---|
| Framework | React 18 + TypeScript |
| Build tool | Vite |
| Styling | Tailwind CSS |
| Notifications | react-hot-toast |
| Deployment | Built to `backend/static/`, served directly by FastAPI as a SPA |

---

## Installation & Build

### Prerequisites

| Requirement | Details |
|---|---|
| Hardware | Jetson Orin (any variant) |
| OS | Ubuntu 22.04 ARM64 (JetPack 6.x, L4T r36.4) |
| Docker | Engine ≥ 24 + **NVIDIA Container Toolkit** |
| ZED SDK | 5.2.3 installed on the host |
| Python | 3.10 |
| Node.js | ≥ 18 + npm |
| ffmpeg |
| Disk | ~15 GB free (ZED base image ~8 GB + RTAB-Map build ~4 GB) |

You can download the ZED 2I SDK from this page:
https://www.stereolabs.com/en-fr/developers/release/5.2
ZED SDK for JetPack 6.2.2 (L4T 36.5) 5.2 (Jetson Orin, CUDA 12.6)


Verify NVIDIA Container Toolkit:
```bash
sudo docker run --rm --gpus all nvidia/cuda:12.6.0-base-ubuntu22.04 nvidia-smi
```

### 1. Clone the repository

```bash
git clone git@github.com:intuitiverobots/ir-vista-mapping.git
cd ir-vista-mapping
```

### 2. Build the SLAM Docker image

```bash
docker build \
    --file Dockerfile.rtabmap_standalone \
    --tag  rtabmap_standalone:latest \
    .
```

> Compiles RTAB-Map 0.21.4 from source. Expect **20–40 minutes** on Jetson Orin.

To build a specific RTAB-Map version:
```bash
docker build \
    --build-arg RTABMAP_VERSION=0.21.5 \
    --file Dockerfile.rtabmap_standalone \
    --tag  rtabmap_standalone:0.21.5 \
    .
```

### 3. Install Python dependencies

The backend uses **system Python** (no virtual environment). The ZED SDK installs `pyzed` globally to expose CUDA and TensorRT drivers — isolating it inside a standard venv would break those native bindings.

```bash
cd backend
pip3 install -r requirements.txt
```

### 4. Build the frontend

```bash
cd frontend
npm install
npm run build      # outputs to ../backend/static/
cd ..
```

if np and node are not installed, install it with:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.5/install.sh | bash
\. "$HOME/.nvm/nvm.sh"
nvm install 24
node -v # Should print "v24.17.0".
npm -v
```

### 5. Generate SSL certificate (for HTTPS / microphone access)

Browser microphone access (`getUserMedia`) is **only allowed over HTTPS**
(except on `localhost`).  A self-signed certificate is sufficient for field use —
the operator simply accepts the browser warning on first visit.

Generate the key and certificate with OpenSSL (pre-installed on Ubuntu):

```bash
# From the repo root:
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem \
    -days 3650 -nodes \
    -subj "/CN=jetson.local/O=VistaMapper" \
    -addext "subjectAltName = DNS:jetson.local,IP:10.42.0.1,IP:127.0.0.1"
```

| Flag | Purpose |
|---|---|
| `-x509` | Self-signed certificate (no CA needed) |
| `-days 3650` | Valid for ~10 years |
| `-nodes` | No passphrase on the private key (required for unattended startup) |
| `-subj` | Skips the interactive prompts |
| `-addext subjectAltName` | Lets the browser match multiple addresses (mDNS name + hotspot IP + localhost) |

> **Add your actual hotspot IP** if it differs from `10.42.0.1` (the default
> for Jetson's built-in hotspot).  You can list multiple `IP:` entries.

Verify the certificate was created:

```bash
ls -l cert.pem key.pem
# -rw-rw-r--  ... cert.pem
# -rw-------  ... key.pem
```

### 6. Start the server

```bash
python3 -m backend.main --host 0.0.0.0 --port 8080
```

The server auto-detects `cert.pem` and `key.pem` in the repo root.  When both are
present it starts in **HTTPS** mode (required for browser microphone access).
Otherwise it falls back to plain HTTP.

You should see this line in the startup logs when HTTPS is active:

```
SSL enabled – HTTPS on https://0.0.0.0:8080
```

If you instead see:

```
SSL disabled (files missing: …/cert.pem / …/key.pem)
```

double-check that you ran `openssl` from the repository root and that both files
exist.

The app is then available at:

| Mode | URL |
|---|---|
| HTTPS | `https://<jetson-ip>:8080` |
| HTTP  | `http://<jetson-ip>:8080` |

---

## Field Usage — Network Access

The typical field setup does **not** require a router. Two options:

### Option A — Jetson Wi-Fi Hotspot

Enable the Jetson's built-in hotspot (Settings → Wi-Fi → Hotspot).
Connect the smartphone to the Jetson's hotspot network, then open:

```
https://10.42.0.1:8080
```

or if mDNS resolves: `https://jetson.local:8080`

> **Note:** The self-signed certificate triggers a browser warning on first visit.
> Click **Advanced → Proceed** to accept it.  HTTPS is required for microphone
> access (push-to-talk / audio recording).

### Option B — Smartphone USB tethering / mobile hotspot

Share the phone's connection to the Jetson. Both devices end up on the same LAN.
The Jetson's mDNS name resolves automatically on most modern phones:

```
https://jetson.local:8080
```

> **Tip:** bookmark the URL on the smartphone home screen for one-tap access.
> Accept the self-signed certificate warning on first visit to enable microphone access.

---

## Autostart & Background Service (systemd)

For headless field deployment, run Vista Mapper as a systemd service so it starts automatically at boot and restarts on failure — no terminal session required.

### 1. Create the service unit

Create `/etc/systemd/system/vista-mapper.service`:

```ini
[Unit]
Description=Vista Mapper – SLAM pipeline web interface
After=network.target

[Service]
Type=simple
User=jetson
WorkingDirectory=/home/jetson/jetson/zed2i/ir-vista-mapping
ExecStart=/usr/bin/python3 -m backend.main --host 0.0.0.0 --port 8080
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

> Adjust `User` and `WorkingDirectory` if your username or repository path differs.

### 2. Enable and start the service

```bash
sudo systemctl daemon-reload
sudo systemctl enable vista-mapper
sudo systemctl start  vista-mapper
```

Check that it is running:

```bash
sudo systemctl status vista-mapper
```

View live logs:

```bash
journalctl -u vista-mapper -f
```

### 3. Shell aliases for quick control

Add the following lines to `~/.bashrc` (or `~/.zshrc`) for single-word commands:

```bash
# Vista Mapper service shortcuts
alias vista-mapper-start='sudo systemctl start  vista-mapper'
alias vista-mapper-stop='sudo systemctl stop   vista-mapper'
alias vista-mapper-log='journalctl -u vista-mapper -f'
```

Reload the shell:

```bash
source ~/.bashrc
```

You can now run `vista-mapper-start` and `vista-mapper-stop` from any terminal.

---

## Pipeline

### Steps

The pipeline is split into 6 independent steps. Each step can be individually skipped from the UI (generating the corresponding `--skip-xxx` flag passed to `run_pipeline.py`).

| # | Step | Script | Skip flag |
|---|---|---|---|
| 1 | Camera intrinsics | `zed_camera_info.py` | `--skip-camera-info` |
| 2 | SLAM (RTAB-Map) | `process_svo.py` → Docker | `--skip-slam` |
| 3 | SVO export (MP4 + depth PNGs) | `svo_export.py` | `--skip-video` / `--skip-depth` |
| 4 | Pose conversion | `convert_poses.py` | `--skip-poses` |
| 5 | 2D projection | `project_ply.py` | `--skip-projection` |
| 6 | ZIP assembly | *(inline in run_pipeline.py)* | `--skip-zip` |

Steps 2 and 3 run **in parallel** (both read the SVO file independently, writing to different outputs).

The final ZIP contains: `positions.json`, `<name>.mp4`, `depth/*.png`, `map.pgm`, `map.yaml`, `camera_info.json`, `depth_camera_info.json`.

### SVO export modes

Step 3 uses `svo_export.py` which selects the export mode automatically based on which sub-options are enabled:

| Enabled | Mode | Description |
|---|---|---|
| Video + Depth | `5` | Single SVO pass: MP4 + depth PNG sequence |
| Video only | `0` | MP4 only |
| Depth only | `4` | Depth PNG sequence only |

### Preset YAML configuration

Each pipeline run is driven by a YAML preset (`config/presets/`). Key parameters:

| Parameter | Description |
|---|---|
| `min_z` / `max_z` | Height slice for 2D projection (metres) |
| `resolution` | Map cell size (metres/pixel) |
| `side` | Camera side for video export (`left` / `right`) |
| `depth_scale` | Scale factor for depth image resolution (default: `0.75`) |
| `depth_compression` | PNG compression level for depth images (0–9, default: `5`) |
| `trim_start` / `trim_end` | Seconds to skip at start/end of the SVO |
| `render` | 3D export mode: `cloud` / `mesh` / `texture` |
| `superpoint` | Enable SuperPoint+SuperGlue features for loop closure |
| `quality` | ZED depth quality (0–6) |

RTAB-Map parameters can also be overridden per-preset under the `rtabmap:` key.

### Key RTAB-Map parameters (tuning guide)

| Parameter | Default | Effect |
|---|---|---|
| `Grid/CellSize` | `0.05` | Map resolution in metres (smaller = finer, more RAM) |
| `Odom/Strategy` | `0` (F2M) | `0`=Frame-to-Map, `1`=FOVIS, `2`=ORB |
| `Rtabmap/DetectionRate` | `1` | Loop closure checks per second; `0`=every frame |
| `Mem/STMSize` | `30` | Short-term memory window; increase for large environments |
| `Optimizer/Strategy` | `0` (TORO) | `0`=TORO (ARM64 built-in), `1`=g2o, `2`=GTSAM |
| `Grid/RayTracing` | `true` | Better free-space estimation; slower |

Full RTAB-Map parameter reference: <https://github.com/introlab/rtabmap/wiki/Appendix>

---

## Outputs

| File | Description |
|---|---|
| `rtabmap.db` | Full RTAB-Map database: poses, point clouds, loop closures |
| `rtabmap_cloud.ply` | Voxel-filtered coloured point cloud |
| `map.pgm` | 2D occupancy grid (0=occupied, 205=unknown, 254=free) |
| `map.yaml` | ROS-compatible map metadata (resolution, origin) |
| `map_manual.pgm` | Alternative 2D map from manual PLY projection (Step 5) |
| `rtabmap_poses.txt` | Raw RTAB-Map pose trajectory |
| `positions.json` | Converted pose trajectory (Step 4 output) |
| `camera_info.json` | Colour camera intrinsic matrix |
| `depth_camera_info.json` | Depth camera intrinsic matrix (scaled by `depth_scale`) |
| `<name>.mp4` | H.264 re-encoded video (browser-compatible) |
| `depth/*.png` | 16-bit depth PNG sequence (millimetres) |
| `<name>.zip` | Final archive with all of the above |

---

## Project Structure

```
vista-mapping-pipeline/
│
├── backend/                        # FastAPI application
│   ├── main.py                     # Entry point, static file serving
│   ├── config.py                   # Shared paths (REPO_ROOT)
│   ├── routers/
│   │   ├── pipeline.py             # Pipeline endpoints (start, logs, download)
│   │   └── capture.py              # Recording endpoints (start, stop, logs)
│   ├── utils/
│   │   └── process_manager.py      # Subprocess management + SSE streaming
│   └── static/                     # Built frontend (generated by npm run build)
│
├── frontend/                       # React / TypeScript SPA
│   ├── src/App.tsx                 # Single-page application (all UI logic)
│   ├── vite.config.ts
│   └── package.json
│
├── src/                            # Python pipeline scripts
│   ├── run_pipeline.py             # Main orchestrator (6 steps)
│   ├── process_svo.py              # SLAM via Docker (rtabmap_standalone)
│   ├── svo_export.py               # MP4 + depth PNG export from SVO2
│   ├── zed_camera_info.py          # ZED camera intrinsics extractor
│   ├── convert_poses.py            # RTAB-Map poses → positions.json
│   ├── project_ply.py              # PLY point cloud → 2D occupancy grid
│   └── svo_recording.py            # ZED SVO2 capture script
│
├── config/
│   └── presets/                    # YAML pipeline presets
│       ├── indoor.yaml
│       ├── outdoor.yaml
│       └── garage.yaml
│
├── tools_patch/ZedSvo/             # Custom C++ SLAM tool source
│   ├── main.cpp                    # CameraStereoZed + F2M odom + OccupancyGrid
│   └── CMakeLists.txt
│
├── data/
│   ├── raw/                        # Input SVO2 files
│   ├── outputs/                    # Pipeline results (one folder per session)
│   └── logs/                       # Pipeline run logs
│
├── models/                         # SuperPoint / SuperGlue weights
├── tools/                          # Compiled native binaries (zed_svo)
├── Dockerfile.rtabmap_standalone   # ARM64 Docker image (RTAB-Map + ZED SDK)
└── README.md
```

---

## Troubleshooting

**Browser shows "206 Partial Content" / "Invalid HTTP request" in server logs**
→ The browser is trying HTTPS but the server is running in HTTP-only mode
  (no `cert.pem` / `key.pem` found).  Generate the certificates first — see
  **Step 5** in the Installation section above.
→ Also check that you are using `https://` in the URL, not `http://`.

**`image not found` when starting the pipeline**
→ Build the Docker image first (Step 2 above).

**ZED SDK initialisation fails on SVO file**
→ Ensure the SVO was recorded with a ZED 2i and ZED SDK ≥ 5.0.
→ Check the file is not corrupted: `file <recording>.svo2` should show a binary file.

**RTAB-Map exits immediately with `No input image`**
→ The SVO path inside the container must be `/data/<filename>`. Check that `--svo` points to the actual `.svo2` file, not a directory.

**Pipeline reports `[FAILED exit=None]`**
→ The subprocess stdout was not fully drained before checking the return code. This is a known issue fixed in `run_pipeline.py` by calling `proc.wait()` after joining reader threads.

**Out of memory during Docker build**
→ Reduce parallel jobs: in `Dockerfile.rtabmap_standalone`, change `make -j$(nproc)` to `make -j2`.

**`docker: Error response from daemon: could not select device driver "nvidia"`**
→ NVIDIA Container Toolkit is not installed or not configured.
   Follow: <https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html>

**Qt platform error (`QXcbConnection: Could not connect to display`)**
→ Already handled: the pipeline sets `QT_QPA_PLATFORM=offscreen` inside the container.

---

## Platform

| | |
|---|---|
| Hardware | NVIDIA Jetson Orin |
| OS | Ubuntu 22.04 ARM64 |
| JetPack | 6.1 (L4T r36.4) |
| CUDA | 12.6 |
| ZED SDK | 5.2 |
| RTAB-Map | 0.21.4 (inside Docker) |
| Docker base image | `stereolabs/zed:5.2-tools-devel-l4t-r36.4` |

---

## Related modules

- [`vista-alpha/webapp/zed2i_node/`](../vista-alpha/webapp/zed2i_node/) — ROS 2 ZED node for live operation
- [`video-analysis-pipeline/`](../video-analysis-pipeline/) — Video analytics pipeline


## Troubleshoot:
If you have a downloading error like this:

```bash
[process_svo.py] [2026-06-19 13:18:28 UTC][ZED][INFO] [Init] Serial Number: S/N 37596972
[process_svo.py] [2026-06-19 13:18:28 UTC][ZED][INFO] [Init] No calibration file was found for SN 37596972. Downloading the file...
[process_svo.py] [2026-06-19 13:24:01 UTC][ZED][ERROR] CALIBRATION FILE NOT AVAILABLE in sl::ERROR_CODE sl::Camera::open(sl::InitParameters)
[process_svo.py] [ERROR] (2026-06-19 13:24:01.259) CameraStereoZed.cpp:455::init() Camera initialization failed: "CALIBRATION FILE NOT AVAILABLE"
[process_svo.py] [ERROR] Failed to open SVO file: /data/Hpo-test-audio.svo2
```

You can download the file manually:
http://calib.stereolabs.com/?SN=37596972

Then copy it to the local settings:
```bash
sudo cp SN37596972.conf /usr/local/zed/settings/
```
