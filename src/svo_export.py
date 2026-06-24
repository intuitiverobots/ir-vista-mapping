########################################################################
#
# Copyright (c) 2022, STEREOLABS.
#
# All rights reserved.
#
# THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
# "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
# LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
# A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
# OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
# SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
# LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
# DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
# THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
# (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
# OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
#
########################################################################

import sys
import signal
import subprocess
import tempfile
import pyzed.sl as sl
import numpy as np
import cv2
from pathlib import Path
import enum
import argparse
import os

class AppType(enum.Enum):
    LEFT_AND_RIGHT = 1
    LEFT_AND_DEPTH = 2
    LEFT_AND_DEPTH_16 = 3
    COMBINED_VIDEO_DEPTH_16 = 5


LOG_INTERVAL = 50  # print progress every N exported frames


def main(opt):
    # Get input parameters
    svo_input_path = opt.input_svo_file
    output_dir = opt.output_path_dir
    video_output_path = opt.output_file
    output_as_video = True
    app_type = AppType.LEFT_AND_RIGHT
    if opt.mode == 1 or opt.mode == 3:
        app_type = AppType.LEFT_AND_DEPTH
    if opt.mode == 4:
        app_type = AppType.LEFT_AND_DEPTH_16
    if opt.mode == 5:
        app_type = AppType.COMBINED_VIDEO_DEPTH_16

    # Check if exporting to AVI or SEQUENCE
    if opt.mode not in (0, 1, 5):
        output_as_video = False

    if not output_as_video and not os.path.isdir(output_dir):
        os.makedirs(output_dir, exist_ok=True)
    if opt.mode == 5 and output_dir and not os.path.isdir(output_dir):
        os.makedirs(output_dir, exist_ok=True)

    # Specify SVO path parameter
    init_params = sl.InitParameters()
    init_params.set_from_svo_file(svo_input_path)
    init_params.svo_real_time_mode = False  # Don't convert in realtime
    init_params.coordinate_units = sl.UNIT.MILLIMETER  # Use milliliter units (for depth measurements)

    # Create ZED objects
    zed = sl.Camera()

    # Open the SVO file specified as a parameter
    err = zed.open(init_params)
    if err > sl.ERROR_CODE.SUCCESS:
        sys.stdout.write(repr(err))
        zed.close()
        exit()

    # Get camera info once
    cam_info = zed.get_camera_information()
    image_size = cam_info.camera_configuration.resolution
    width = image_size.width
    height = image_size.height
    width_sbs = width * 2
    fps = cam_info.camera_configuration.fps
    nb_frames = zed.get_svo_number_of_frames()

    # Log camera info
    sys.stdout.write(
        f"Camera info:\n"
        f"  Model       : {cam_info.camera_model}\n"
        f"  Serial      : {cam_info.serial_number}\n"
        f"  Resolution  : {width}x{height}\n"
        f"  FPS         : {fps}\n"
        f"  Total frames: {nb_frames} ({nb_frames / fps:.1f}s)\n"
    )

    # Prepare side by side image container equivalent to CV_8UC4
    svo_image_sbs_rgba = np.zeros((height, width_sbs, 4), dtype=np.uint8)

    # Prepare single image containers
    left_image = sl.Mat()
    right_image = sl.Mat()
    depth_image = sl.Mat()

    video_writer = None
    tmp_avi_path = None
    if output_as_video:
        ext = os.path.splitext(video_output_path)[1].lower()
        # For MP4 output: write to a temp AVI first, then re-encode with ffmpeg (libx264, browser-compatible)
        if ext == '.mp4':
            tmp_fd, tmp_avi_path = tempfile.mkstemp(suffix='.avi')
            os.close(tmp_fd)
            writer_path = tmp_avi_path
            fourcc = cv2.VideoWriter.fourcc('M', '4', 'S', '2')
        else:  # .avi
            writer_path = video_output_path
            fourcc = cv2.VideoWriter.fourcc('M', '4', 'S', '2')
        width_out = width if opt.side != 'both' else width_sbs
        video_writer = cv2.VideoWriter(writer_path,
                                       fourcc,
                                       fps,
                                       (width_out, height))
        if not video_writer.isOpened():
            sys.stdout.write("OpenCV video writer cannot be opened. Please check the output file path and write "
                             "permissions.\n")
            zed.close()
            exit()

    rt_param = sl.RuntimeParameters()

    # Compute frame range from trim parameters
    start_frame = int(round(opt.trim_start * fps)) if opt.trim_start > 0 else 0
    end_frame = nb_frames - int(round(opt.trim_end * fps)) if opt.trim_end > 0 else nb_frames
    end_frame = max(start_frame + 1, min(end_frame, nb_frames))
    export_frames = end_frame - start_frame
    sys.stdout.write(
        f"Export range: frames {start_frame}–{end_frame} "
        f"({export_frames} frames, {export_frames / fps:.1f}s)\n"
    )

    if start_frame > 0:
        zed.set_svo_position(start_frame)

    # Start SVO conversion to AVI/SEQUENCE
    sys.stdout.write("Converting SVO... Use Ctrl-C to interrupt conversion.\n")

    first_ts_ns = None

    try:
        while True:
            err = zed.grab(rt_param)
            if err <= sl.ERROR_CODE.SUCCESS:
                svo_position = zed.get_svo_position()
                ts_ns = zed.get_timestamp(sl.TIME_REFERENCE.IMAGE).get_nanoseconds()
                if first_ts_ns is None:
                    first_ts_ns = ts_ns
                rel_ts = (ts_ns - first_ts_ns) / 1e9

                # Stop early if trim-end reached
                if svo_position >= end_frame:
                    break

                # Retrieve SVO images
                zed.retrieve_image(left_image, sl.VIEW.LEFT)

                if app_type == AppType.LEFT_AND_RIGHT:
                    zed.retrieve_image(right_image, sl.VIEW.RIGHT)
                elif app_type == AppType.LEFT_AND_DEPTH:
                    zed.retrieve_image(right_image, sl.VIEW.DEPTH)
                elif app_type in (AppType.LEFT_AND_DEPTH_16, AppType.COMBINED_VIDEO_DEPTH_16):
                    zed.retrieve_measure(depth_image, sl.MEASURE.DEPTH)

                if output_as_video:
                    if app_type == AppType.COMBINED_VIDEO_DEPTH_16:
                        # Mode 5: right image not retrieved, always use left
                        frame_rgba = left_image.get_data()
                    elif opt.side == 'both':
                        # Copy the left image to the left side of SBS image
                        svo_image_sbs_rgba[0:height, 0:width, :] = left_image.get_data()
                        # Copy the right image to the right side of SBS image
                        svo_image_sbs_rgba[0:, width:, :] = right_image.get_data()
                        frame_rgba = svo_image_sbs_rgba
                    elif opt.side == 'left':
                        frame_rgba = left_image.get_data()
                    else:  # right
                        frame_rgba = right_image.get_data()
                    # Convert SVO image from RGBA to RGB
                    ocv_image_rgb = cv2.cvtColor(frame_rgba, cv2.COLOR_RGBA2RGB)
                    # Write the RGB image in the video
                    assert video_writer is not None
                    video_writer.write(ocv_image_rgb)
                    # Mode 5: also save depth PNG alongside video
                    if app_type == AppType.COMBINED_VIDEO_DEPTH_16 and output_dir:
                        raw = np.nan_to_num(depth_image.get_data(), nan=65535.0, posinf=65535.0, neginf=65535.0)
                        raw[raw < 0] = 65535.0
                        raw = np.squeeze(raw).astype(np.uint16)
                        if opt.depth_scale != 1.0:
                            dh = max(1, int(round(height * opt.depth_scale)))
                            dw = max(1, int(round(width * opt.depth_scale)))
                            raw = cv2.resize(raw, (dw, dh), interpolation=cv2.INTER_NEAREST)
                        cv2.imwrite(
                            os.path.join(output_dir, f"{rel_ts:.3f}.png"),
                            raw,
                            [cv2.IMWRITE_PNG_COMPRESSION, opt.depth_compression],
                        )
                else:
                    # Generate file names
                    if opt.side in ('both', 'left'):
                        filename1 = output_dir + "/" + ("left%s.png" % str(svo_position).zfill(6))
                        # Save Left images
                        cv2.imwrite(str(filename1), left_image.get_data())
                    if opt.side in ('both', 'right'):
                        if app_type == AppType.LEFT_AND_RIGHT:
                            filename2 = os.path.join(output_dir, "right%s.png" % str(svo_position).zfill(6))
                            cv2.imwrite(str(filename2), right_image.get_data())
                        elif app_type == AppType.LEFT_AND_DEPTH:
                            filename2 = os.path.join(output_dir, f"{rel_ts:.3f}.png")
                            cv2.imwrite(str(filename2), right_image.get_data())
                        elif app_type == AppType.LEFT_AND_DEPTH_16:
                            filename2 = os.path.join(output_dir, f"{rel_ts:.3f}.png")
                            raw = np.nan_to_num(depth_image.get_data(), nan=65535.0, posinf=65535.0, neginf=65535.0)
                            raw[raw < 0] = 65535.0
                            raw = np.squeeze(raw).astype(np.uint16)
                            if opt.depth_scale != 1.0:
                                dh = max(1, int(round(height * opt.depth_scale)))
                                dw = max(1, int(round(width * opt.depth_scale)))
                                raw = cv2.resize(raw, (dw, dh), interpolation=cv2.INTER_NEAREST)
                            cv2.imwrite(str(filename2), raw, [cv2.IMWRITE_PNG_COMPRESSION, opt.depth_compression])

                done = svo_position - start_frame + 1
                if done == 1 or done % LOG_INTERVAL == 0 or done == export_frames:
                    pct = done / export_frames * 100
                    sys.stdout.write(f"[frame {done}/{export_frames} | {pct:.1f}% | {rel_ts:.1f}s]\n")
                    sys.stdout.flush()
            if err == sl.ERROR_CODE.END_OF_SVOFILE_REACHED:
                sys.stdout.write("SVO end has been reached. Exiting now.\n")
                break
    except KeyboardInterrupt:
        sys.stdout.write("\nInterrupted by user.\n")
    finally:
        if output_as_video and video_writer is not None:
            video_writer.release()
            if tmp_avi_path is not None:
                # Re-encode to H.264 MP4 (browser-compatible)
                sys.stdout.write(f"Re-encoding to H.264 MP4: {video_output_path}\n")
                result = subprocess.run(
                    [
                        "ffmpeg", "-y",
                        "-i", tmp_avi_path,
                        "-c:v", "libx264",
                        "-pix_fmt", "yuv420p",
                        "-movflags", "+faststart",
                        "-an",
                        video_output_path,
                    ],
                    stderr=subprocess.PIPE,
                )
                os.remove(tmp_avi_path)
                if result.returncode != 0:
                    sys.stdout.write("ffmpeg re-encoding failed:\n" + result.stderr.decode() + "\n")
                else:
                    sys.stdout.write("Re-encoding done.\n")
                    # --- Audio mux ---
                    #
                    # Two modes are supported:
                    # 1. New  segmented  mode:  data/raw/<stem>_audio/manifest.json
                    #    contains per-segment start/end times.  Segments are placed at
                    #    their correct video-timeline offsets with silence in gaps.
                    # 2. Legacy single-file mode: a .webm/.ogg next to the SVO file.
                    #    Used when no manifest directory exists.
                    svo_stem = Path(opt.input_svo_file)
                    audio_dir = svo_stem.parent / f"{svo_stem.stem}_audio"
                    manifest_path = audio_dir / "manifest.json"

                    # ── Helper: get duration via ffprobe ─────────────────
                    def _get_duration(p: str) -> float | None:
                        r = subprocess.run(
                            ["ffprobe", "-v", "error",
                             "-show_entries", "format=duration",
                             "-of", "default=noprint_wrappers=1:nokey=1", p],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                        )
                        try:
                            return float(r.stdout.decode().strip())
                        except ValueError:
                            return None

                    vid_dur = _get_duration(video_output_path)

                    # ── Check for segmented manifest first ───────────────
                    if manifest_path.is_file() and vid_dur is not None:
                        import json as _json
                        try:
                            manifest = _json.loads(manifest_path.read_text())
                        except (ValueError, OSError):
                            manifest = {"segments": []}

                        raw_segments = manifest.get("segments", [])
                        trim_s = float(opt.trim_start)
                        trim_e = float(opt.trim_end)

                        # Adjust segment times for video trim and clip to video bounds
                        active: list[tuple[Path, float, float]] = []
                        for seg in raw_segments:
                            seg_path = audio_dir / seg["file"]
                            if not seg_path.is_file():
                                continue
                            t0 = float(seg["start_time"]) - trim_s
                            t1 = float(seg["end_time"]) - trim_s
                            if t1 <= 0.0:
                                continue
                            vid_end = vid_dur if trim_e == 0 else max(0.0, vid_dur)
                            if t0 >= vid_end:
                                continue
                            t0 = max(0.0, t0)
                            t1 = min(vid_end, t1)
                            if t1 > t0:
                                active.append((seg_path, t0, t1))

                        if active:
                            sys.stdout.write(
                                f"Muxing {len(active)} audio segment(s) with ffmpeg "
                                f"(video={vid_dur:.2f}s)...\n"
                            )
                            # Build ffmpeg command: silent background + adelay'd segments → amix
                            ff_cmd = [
                                "ffmpeg", "-y",
                                "-i", video_output_path,
                            ]
                            filter_chains: list[str] = []
                            amix_labels: list[str] = []
                            for i, (spath, t0, _t1) in enumerate(active):
                                ff_cmd.extend(["-i", str(spath)])
                                delay_ms = int(round(t0 * 1000))
                                filter_chains.append(
                                    f"[{i + 1}:a]aresample=44100,aformat=channel_layouts=stereo,"
                                    f"adelay={delay_ms}|{delay_ms}[a{i}]"
                                )
                                amix_labels.append(f"[a{i}]")

                            # anullsrc background track matching the video duration (stereo, 44100 Hz)
                            filter_complex = (
                                f"anullsrc=r=44100:cl=stereo:d={vid_dur}[bg];"
                                + ";".join(filter_chains) + ";"
                                + f"[bg]{''.join(amix_labels)}amix="
                                  f"inputs={len(amix_labels) + 1}:"
                                  f"duration=first:dropout_transition=0[outa]"
                            )
                            ff_cmd += [
                                "-filter_complex", filter_complex,
                                "-map", "0:v",
                                "-map", "[outa]",
                                "-c:v", "copy",
                                "-c:a", "aac",
                            ]
                            tmp_muxed = video_output_path + ".muxed.mp4"
                            ff_cmd.append(tmp_muxed)

                            mux_result = subprocess.run(ff_cmd, stderr=subprocess.PIPE)
                            if mux_result.returncode == 0:
                                os.replace(tmp_muxed, video_output_path)
                                sys.stdout.write("Audio mux done.\n")
                            else:
                                if os.path.exists(tmp_muxed):
                                    os.remove(tmp_muxed)
                                err_out = mux_result.stderr.decode(errors="replace")
                                # Print only the last 4 lines of ffmpeg output on failure
                                err_tail = "\n".join(
                                    [l for l in err_out.splitlines() if l.strip()][-4:]
                                )
                                sys.stdout.write(
                                    f"Audio mux failed (ffmpeg exit {mux_result.returncode}):\n"
                                    f"{err_tail}\n"
                                )
                        else:
                            sys.stdout.write("Audio mux skipped: no valid segments after trim.\n")

                    # ── Fallback: legacy single-file audio ───────────────
                    elif not manifest_path.is_file():
                        audio_path = None
                        for _ext in ('.webm', '.ogg'):
                            _candidate = svo_stem.with_suffix(_ext)
                            if _candidate.exists():
                                audio_path = _candidate
                                break
                        if audio_path is not None:
                            aud_dur = _get_duration(str(audio_path))
                            if vid_dur is not None and aud_dur is not None:
                                # Add a small correction for SVO tail latency:
                                # mr.stop() and SIGINT are sent simultaneously, but svo_recording.py
                                # keeps grabbing 1-2 frames after SIGINT before closing the SVO,
                                # making vid_dur slightly longer than the real audio content duration.
                                # This means (aud_dur - vid_dur) under-estimates the true head gap,
                                # so without correction the audio plays slightly late.
                                _SVO_TAIL_S = 0.3
                                audio_offset = max(0.0, aud_dur - vid_dur + _SVO_TAIL_S)
                                sys.stdout.write(
                                    f"Muxing audio: {audio_path.name} "
                                    f"(video={vid_dur:.2f}s, audio={aud_dur:.2f}s, skip={audio_offset:.2f}s)\n"
                                )
                                tmp_muxed = video_output_path + ".muxed.mp4"
                                mux_result = subprocess.run(
                                    [
                                        "ffmpeg", "-y",
                                        "-i", video_output_path,
                                        "-ss", f"{audio_offset:.6f}",
                                        "-i", str(audio_path),
                                        "-c:v", "copy",
                                        "-c:a", "aac",
                                        tmp_muxed,
                                    ],
                                    stderr=subprocess.PIPE,
                                )
                                if mux_result.returncode == 0:
                                    os.replace(tmp_muxed, video_output_path)
                                    sys.stdout.write("Audio mux done.\n")
                                else:
                                    if os.path.exists(tmp_muxed):
                                        os.remove(tmp_muxed)
                                    sys.stdout.write("Audio mux failed:\n" + mux_result.stderr.decode() + "\n")
                            else:
                                sys.stdout.write("Audio mux skipped: could not read durations.\n")
        zed.close()
    sys.stdout.write("Exiting svo export.\n")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(formatter_class=argparse.RawTextHelpFormatter)
    parser.add_argument('--mode', type = int, required=True, help=" Mode 0: LEFT+RIGHT video.\n Mode 1: LEFT+DEPTH_VIEW video.\n Mode 2: LEFT+RIGHT image sequence.\n Mode 3: LEFT+DEPTH_VIEW image sequence.\n Mode 4: LEFT+DEPTH_16BIT image sequence.\n Mode 5: LEFT video + DEPTH_16BIT sequence (combined, single SVO pass).")
    parser.add_argument('--input_svo_file', type=str, required=True, help='Path to the .svo file')
    parser.add_argument('--output_file', type=str, help='Path to the output video file (.mp4 or .avi), required for modes 0 and 1.', default='')
    parser.add_argument('--output_path_dir', type=str, help='Path to a directory, where .png will be written, if mode includes image sequence export', default='')
    parser.add_argument('--side', type=str, choices=['left', 'right', 'both'], default='both',
                        help='Which side to export: left, right, or both (default: both).')
    parser.add_argument('--trim-start', type=float, default=0.0,
                        help='Skip the first N seconds of the SVO (default: 0).')
    parser.add_argument('--trim-end', type=float, default=0.0,
                        help='Skip the last N seconds of the SVO (default: 0).')
    parser.add_argument('--depth-scale', type=float, default=0.75,
                        help='Scale factor for depth image resolution (e.g. 0.5 → half size). Default: 1.0.')
    parser.add_argument('--depth-compression', type=int, default=5, choices=range(10),
                        metavar='[0-9]',
                        help='PNG compression level for depth images (0=none, 9=max). Default: 5.')
    opt = parser.parse_args()
    if opt.mode not in (0, 1, 2, 3, 4, 5):
        print("Mode should be 0-5.\n 0: LEFT+RIGHT video\n 1: LEFT+DEPTH_VIEW video\n 2: LEFT+RIGHT sequence\n 3: LEFT+DEPTH_VIEW sequence\n 4: LEFT+DEPTH_16BIT sequence\n 5: LEFT+RIGHT video + DEPTH_16BIT sequence (combined)")
        exit()
    if not opt.input_svo_file.endswith((".svo", ".svo2")):
        print("--input_svo_file parameter should be a .svo file but is not : ",opt.input_svo_file,"Exit program.")
        exit()
    if not os.path.isfile(opt.input_svo_file):
        print("--input_svo_file parameter should be an existing file but is not : ",opt.input_svo_file,"Exit program.")
        exit()
    if opt.mode in (0, 1, 5) and len(opt.output_file) == 0:
        print(f"In mode {opt.mode}, --output_file parameter needs to be specified.")
        exit()
    if opt.mode in (0, 1, 5) and not opt.output_file.endswith((".mp4", ".avi")):
        print("--output_file parameter should be a .mp4 or .avi file but is not : ", opt.output_file, "Exit program.")
        exit()
    if opt.mode in (2, 3, 4, 5) and len(opt.output_path_dir) == 0:
        print(f"In mode {opt.mode}, --output_path_dir parameter needs to be specified.")
        exit()
    if opt.mode in (2, 3, 4, 5) and not os.path.isdir(opt.output_path_dir):
        os.makedirs(opt.output_path_dir, exist_ok=True)
    main(opt)
