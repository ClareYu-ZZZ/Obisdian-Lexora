"""
elp-worker — Lexora 的本地伴侣服务（自托管，开源）。

承担插件做不了的重活：faster-whisper 转写（无字幕媒体 → VTT）。
部署参考形态：NAS 上 Docker 常驻，局域网暴露端口。

安全模型：
- loopback 请求免鉴权；任何非 loopback 请求强制 Bearer token。
- token 来自环境变量 LEXORA_TOKEN；未设置则启动时生成并打印一次。
- 公网暴露请走反向代理 TLS 或 Tailscale/WireGuard。

测试模式：LEXORA_FAKE=1 时转写返回固定 VTT（CI / 无模型环境用）。
"""

from __future__ import annotations

import json
import os
import secrets
import shutil
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse

API_VERSION = "1.0"
FAKE = os.environ.get("LEXORA_FAKE") == "1"
WHISPER_MODEL = os.environ.get("LEXORA_WHISPER_MODEL", "small")
PIPER_VOICE = os.environ.get("LEXORA_PIPER_VOICE", "en_US-ryan-high")
PIPER_DIR = Path(os.environ.get("LEXORA_PIPER_DIR", "/voices"))
WHISPER_COMPUTE = os.environ.get("LEXORA_WHISPER_COMPUTE", "int8")
WHISPER_THREADS = int(os.environ.get("LEXORA_WHISPER_THREADS", "4"))
TOKEN = os.environ.get("LEXORA_TOKEN") or secrets.token_urlsafe(24)
if not os.environ.get("LEXORA_TOKEN"):
    print(f"[elp-worker] generated token (set LEXORA_TOKEN to pin it): {TOKEN}", flush=True)

WORK_DIR = Path(os.environ.get("LEXORA_WORK_DIR", tempfile.gettempdir())) / "elp-worker"
WORK_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="elp-worker", version=API_VERSION)


# ---------------------------------------------------------------- auth

def require_auth(request: Request) -> None:
    host = request.client.host if request.client else ""
    if host in ("127.0.0.1", "::1", "localhost"):
        return
    header = request.headers.get("authorization", "")
    if header != f"Bearer {TOKEN}":
        raise HTTPException(status_code=401, detail="missing or invalid bearer token")


# ---------------------------------------------------------------- jobs

@dataclass
class Job:
    id: str
    type: str
    status: str = "queued"            # queued | running | done | failed
    progress: float = 0.0
    error: Optional[str] = None
    result_path: Optional[Path] = None
    created: float = field(default_factory=time.time)


JOBS: dict[str, Job] = {}
JOBS_LOCK = threading.Lock()
_whisper_model = None
_whisper_lock = threading.Lock()
_piper_voices: dict = {}
_piper_lock = threading.Lock()


def _piper_onnx(voice: str | None = None) -> Path:
    return PIPER_DIR / f"{voice or PIPER_VOICE}.onnx"


def _available_voices() -> list[str]:
    if not PIPER_DIR.exists():
        return []
    return sorted(p.stem for p in PIPER_DIR.glob("*.onnx"))


def _has_piper() -> bool:
    if FAKE:
        return True
    if not _piper_onnx().exists():
        return False
    try:
        import piper  # noqa: F401
        return True
    except ImportError:
        return False


def _get_piper(voice: str | None = None):
    key = voice or PIPER_VOICE
    with _piper_lock:
        if key not in _piper_voices:
            from piper import PiperVoice  # lazy
            onnx = _piper_onnx(key)
            _piper_voices[key] = PiperVoice.load(str(onnx), config_path=f"{onnx}.json")
        return _piper_voices[key]


def _silent_wav(seconds: float = 0.3, rate: int = 22050) -> bytes:
    import io
    import wave
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00\x00" * int(seconds * rate))
    return buf.getvalue()


def _get_whisper():
    global _whisper_model
    with _whisper_lock:
        if _whisper_model is None:
            from faster_whisper import WhisperModel  # lazy: heavy import
            _whisper_model = WhisperModel(
                WHISPER_MODEL, compute_type=WHISPER_COMPUTE,
                cpu_threads=WHISPER_THREADS, num_workers=1,
            )
        return _whisper_model


def _fmt_ts(sec: float) -> str:
    ms = int(round(sec * 1000))
    h, rem = divmod(ms, 3600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


FAKE_VTT = """WEBVTT

00:00:00.000 --> 00:00:02.400
This is a fake transcription for testing.

00:00:02.400 --> 00:00:05.100
Replace it by running without LEXORA_FAKE.
"""


def _run_transcribe(job: Job, media: Path, language: str) -> None:
    try:
        job.status = "running"
        out = WORK_DIR / f"{job.id}.vtt"
        if FAKE:
            time.sleep(0.2)
            out.write_text(FAKE_VTT, encoding="utf-8")
        else:
            model = _get_whisper()
            segments, info = model.transcribe(
                str(media), language=language or None, vad_filter=True, beam_size=1,
            )
            total = max(1.0, getattr(info, "duration", 0.0) or 1.0)
            lines = ["WEBVTT", ""]
            for seg in segments:
                lines.append(f"{_fmt_ts(seg.start)} --> {_fmt_ts(seg.end)}")
                lines.append(seg.text.strip())
                lines.append("")
                job.progress = min(0.99, seg.end / total)
            out.write_text("\n".join(lines), encoding="utf-8")
        job.result_path = out
        job.progress = 1.0
        job.status = "done"
    except Exception as e:  # noqa: BLE001 — job errors surface to the client
        job.status = "failed"
        job.error = str(e)
    finally:
        media.unlink(missing_ok=True)


def _run_clip(job: Job, media: Path, segments: list) -> None:
    """ffmpeg 按段切 mp3 并打包 zip（name/start/end 必填）。"""
    import subprocess
    import zipfile
    try:
        job.status = "running"
        if not shutil.which("ffmpeg"):
            raise RuntimeError("ffmpeg not installed")
        out_zip = WORK_DIR / f"{job.id}.zip"
        tmp_dir = WORK_DIR / f"{job.id}_clips"
        tmp_dir.mkdir(exist_ok=True)
        total = max(1, len(segments))
        with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_STORED) as zf:
            for i, seg in enumerate(segments):
                name = str(seg.get("name", f"clip{i:02d}"))
                start = float(seg["start"])
                end = float(seg["end"])
                dur = max(0.2, end - start)
                clip = tmp_dir / f"{name}.mp3"
                cmd = [
                    "ffmpeg", "-y", "-loglevel", "error",
                    "-ss", f"{max(0.0, start - 0.05):.2f}", "-t", f"{dur + 0.1:.2f}",
                    "-i", str(media), "-vn",
                    "-acodec", "libmp3lame", "-q:a", "4", str(clip),
                ]
                subprocess.run(cmd, check=True, timeout=120)
                zf.write(clip, f"{name}.mp3")
                clip.unlink(missing_ok=True)
                job.progress = (i + 1) / total
        shutil.rmtree(tmp_dir, ignore_errors=True)
        job.result_path = out_zip
        job.status = "done"
    except Exception as e:  # noqa: BLE001
        job.status = "failed"
        job.error = str(e)
    finally:
        media.unlink(missing_ok=True)


def _run_ytmedia(job: Job, video_id: str, want_video: bool) -> None:
    """yt-dlp 下载 YouTube 媒体：want_video=True → 720p mp4；否则音轨转 mp3（128k）。"""
    import subprocess
    try:
        job.status = "running"
        ext = "mp4" if want_video else "mp3"
        out = WORK_DIR / f"{job.id}.{ext}"
        if FAKE:
            if want_video:
                subprocess.run(
                    ["ffmpeg", "-y", "-loglevel", "error",
                     "-f", "lavfi", "-i", "color=c=black:s=320x180:d=2",
                     "-f", "lavfi", "-i", "anullsrc=r=22050:cl=mono",
                     "-shortest", str(out)],
                    check=True, timeout=30,
                )
            else:
                subprocess.run(
                    ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi",
                     "-i", "anullsrc=r=22050:cl=mono", "-t", "2", str(out)],
                    check=True, timeout=30,
                )
        else:
            from yt_dlp import YoutubeDL  # type: ignore

            def hook(d: dict) -> None:
                if d.get("status") == "downloading":
                    tb = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
                    if tb:
                        job.progress = min(0.9, (d.get("downloaded_bytes", 0) / tb) * 0.9)
                elif d.get("status") == "finished":
                    job.progress = 0.92

            opts = {
                **_ytdlp_base_opts(),
                "outtmpl": str(WORK_DIR / f"{job.id}.%(ext)s"),
                "progress_hooks": [hook],
            }
            if want_video:
                opts["format"] = (
                    "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]"
                    "/best[height<=720][ext=mp4]/best[ext=mp4]/best"
                )
                opts["merge_output_format"] = "mp4"
            else:
                opts["format"] = "bestaudio/best"
                opts["postprocessors"] = [{
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "mp3",
                    "preferredquality": "128",
                }]
            with YoutubeDL(opts) as ydl:
                ydl.download([f"https://www.youtube.com/watch?v={video_id}"])
            if not out.exists():
                raise RuntimeError(f"{ext} not produced")
        job.result_path = out
        job.progress = 1.0
        job.status = "done"
    except Exception as e:  # noqa: BLE001
        job.status = "failed"
        job.error = str(e)[:300]


COOKIES_FILE = Path(os.environ.get("LEXORA_COOKIES", "/app/cookies.txt"))


def _ytdlp_base_opts() -> dict:
    """全部 yt-dlp 调用共用：防限流 + cookies（绕过 YouTube 的 bot 验证）。"""
    opts = {
        "quiet": True,
        "no_warnings": True,
        "sleep_interval_requests": 1,
        "retries": 5,
        "socket_timeout": 30,
    }
    if COOKIES_FILE.exists():
        opts["cookiefile"] = str(COOKIES_FILE)
    return opts


def _has_ytdlp() -> bool:
    try:
        import yt_dlp  # noqa: F401
        return True
    except ImportError:
        return False


# ---------------------------------------------------------------- endpoints

@app.get("/v1/capabilities", dependencies=[Depends(require_auth)])
def capabilities() -> JSONResponse:
    has_whisper = FAKE
    if not FAKE:
        try:
            import faster_whisper  # noqa: F401
            has_whisper = True
        except ImportError:
            has_whisper = False
    return JSONResponse({
        "apiVersion": API_VERSION,
        "name": "elp-worker",
        "features": {
            "transcribe": has_whisper,
            "tts": _has_piper(),
            "clip": shutil.which("ffmpeg") is not None,
            "subtitle": FAKE or _has_ytdlp(),
            "ytaudio": (FAKE or _has_ytdlp()) and shutil.which("ffmpeg") is not None,
            "cookies": COOKIES_FILE.exists(),
        },
        "models": {"whisper": WHISPER_MODEL, "compute": WHISPER_COMPUTE, "piper": PIPER_VOICE},
        "voices": _available_voices() or ([PIPER_VOICE] if FAKE else []),
        "fake": FAKE,
    })


@app.post("/v1/jobs", dependencies=[Depends(require_auth)])
async def create_job(
    type: str = Form(...),
    file: UploadFile = File(...),
    options: str = Form("{}"),
) -> JSONResponse:
    if type not in ("transcribe", "clip"):
        raise HTTPException(status_code=400, detail=f"unsupported job type: {type}")
    opts = json.loads(options or "{}")
    job = Job(id=uuid.uuid4().hex, type=type)
    media = WORK_DIR / f"{job.id}_{Path(file.filename or 'media').name}"
    with media.open("wb") as fh:
        while chunk := await file.read(1 << 20):
            fh.write(chunk)
    with JOBS_LOCK:
        JOBS[job.id] = job
    if type == "transcribe":
        threading.Thread(
            target=_run_transcribe, args=(job, media, opts.get("language", "en")), daemon=True,
        ).start()
    else:
        threading.Thread(
            target=_run_clip, args=(job, media, opts.get("segments", [])), daemon=True,
        ).start()
    return JSONResponse({"id": job.id, "status": job.status})


@app.get("/v1/jobs/{job_id}", dependencies=[Depends(require_auth)])
def job_status(job_id: str) -> JSONResponse:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    return JSONResponse({
        "id": job.id, "type": job.type, "status": job.status,
        "progress": round(job.progress, 3), "error": job.error,
    })


@app.get("/v1/jobs/{job_id}/result", dependencies=[Depends(require_auth)])
def job_result(job_id: str) -> FileResponse:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    if job.status != "done" or not job.result_path:
        raise HTTPException(status_code=409, detail=f"job is {job.status}")
    if job.result_path.suffix == ".zip":
        return FileResponse(job.result_path, media_type="application/zip", filename="clips.zip")
    if job.result_path.suffix == ".mp3":
        return FileResponse(job.result_path, media_type="audio/mpeg", filename="audio.mp3")
    if job.result_path.suffix == ".mp4":
        return FileResponse(job.result_path, media_type="video/mp4", filename="video.mp4")
    return FileResponse(job.result_path, media_type="text/vtt", filename="transcript.vtt")


@app.delete("/v1/jobs/{job_id}", dependencies=[Depends(require_auth)])
def cancel_job(job_id: str) -> JSONResponse:
    # MVP：faster-whisper 不支持中断，仅从列表移除。
    with JOBS_LOCK:
        JOBS.pop(job_id, None)
    return JSONResponse({"ok": True})


# ---------------------------------------------------------------- tts

from pydantic import BaseModel
from fastapi.responses import Response


class YtAudioRequest(BaseModel):
    video_id: str
    # True → 下载 720p mp4 视频；False/缺省 → 只要 mp3 音轨
    video: bool = False


@app.post("/v1/ytaudio", dependencies=[Depends(require_auth)])
def ytaudio(req: YtAudioRequest) -> JSONResponse:
    """异步任务：下载 YouTube 音轨为 mp3（结果走 /v1/jobs/{id}/result）。"""
    vid = req.video_id.strip()
    if not vid or len(vid) > 20:
        raise HTTPException(status_code=400, detail="bad video_id")
    if not FAKE and not _has_ytdlp():
        raise HTTPException(status_code=501, detail="yt-dlp not installed (pip install yt-dlp)")
    if not shutil.which("ffmpeg"):
        raise HTTPException(status_code=501, detail="ffmpeg not installed")
    job = Job(id=uuid.uuid4().hex, type="ytaudio")
    with JOBS_LOCK:
        JOBS[job.id] = job
    threading.Thread(target=_run_ytmedia, args=(job, vid, bool(req.video)), daemon=True).start()
    return JSONResponse({"job_id": job.id})


class SubtitleRequest(BaseModel):
    video_id: str
    # 语言偏好；yt-dlp 会先取人工字幕，没有再取自动字幕
    lang: str = "en"


@app.post("/v1/subtitle", dependencies=[Depends(require_auth)])
def subtitle(req: SubtitleRequest) -> JSONResponse:
    """只拉 YouTube 字幕（不下载音视频）：人工字幕优先，ASR 自动字幕兜底。"""
    vid = req.video_id.strip()
    if not vid or len(vid) > 20:
        raise HTTPException(status_code=400, detail="bad video_id")
    if FAKE:
        return JSONResponse({"vtt": FAKE_VTT, "auto": False})
    if not _has_ytdlp():
        raise HTTPException(status_code=501, detail="yt-dlp not installed (pip install yt-dlp)")
    import glob
    import tempfile
    from yt_dlp import YoutubeDL  # type: ignore

    url = f"https://www.youtube.com/watch?v={vid}"
    lang = req.lang or "en"
    # 旧套件验证过的要点：
    # 1) 绝不能用 "en.*"——会匹配几十条 en-xx 机器翻译轨道，逐个下载直接被打到 HTTP 429
    # 2) ignore_no_formats_error：只要字幕不下视频流时必须带，否则格式列表拿不到就中断
    # 3) sleep/retries 防限流
    langs = [lang, f"{lang}-orig", f"{lang}-US", f"{lang}-GB"]
    with tempfile.TemporaryDirectory() as td:
        base_opts = {
            **_ytdlp_base_opts(),
            "skip_download": True,
            "ignore_no_formats_error": True,
            "subtitleslangs": langs,
            "subtitlesformat": "vtt",
            "outtmpl": f"{td}/sub.%(ext)s",
        }

        def pick_vtt() -> str | None:
            # 优先级：人工 en > en-US > en-GB > en-orig（orig 多为自动轨）
            from pathlib import Path as _P
            for cand in (f"sub.{lang}.vtt", f"sub.{lang}-US.vtt", f"sub.{lang}-GB.vtt", f"sub.{lang}-orig.vtt"):
                p = _P(td) / cand
                if p.exists():
                    return str(p)
            files = sorted(glob.glob(f"{td}/*.vtt"))
            return files[0] if files else None

        # 先取人工字幕，没有再取自动字幕（两步分开，避免自动字幕覆盖人工）
        for auto, opts in (
            (False, {**base_opts, "writesubtitles": True}),
            (True, {**base_opts, "writeautomaticsub": True}),
        ):
            try:
                with YoutubeDL(opts) as ydl:
                    ydl.download([url])
            except Exception as e:  # noqa: BLE001
                if auto:
                    raise HTTPException(status_code=502, detail=f"yt-dlp failed: {str(e)[:200]}")
                continue
            picked = pick_vtt()
            if picked:
                text = open(picked, encoding="utf-8", errors="replace").read()
                if "WEBVTT" in text:
                    return JSONResponse({"vtt": text, "auto": auto})
    raise HTTPException(status_code=404, detail="no subtitles for this video")


class TtsRequest(BaseModel):
    text: str
    voice: Optional[str] = None
    # 语速：Piper length_scale，>1 更慢。单词朗读客户端会传 ~1.12，避免急促。
    speed: float = 1.0


def _pad_wav(data: bytes, lead: float = 0.12, tail: float = 0.18) -> bytes:
    """首尾加静音垫：避免播放设备起播裁掉头音（听感发闷/吞字）与收尾过急。"""
    import io
    import wave
    try:
        with wave.open(io.BytesIO(data), "rb") as src:
            params = src.getparams()
            frames = src.readframes(src.getnframes())
        unit = params.sampwidth * params.nchannels
        lead_b = b"\x00" * (int(params.framerate * lead) * unit)
        tail_b = b"\x00" * (int(params.framerate * tail) * unit)
        out = io.BytesIO()
        with wave.open(out, "wb") as dst:
            dst.setparams(params)
            dst.writeframes(lead_b + frames + tail_b)
        return out.getvalue()
    except Exception:  # noqa: BLE001 — 垫失败就原样返回
        return data


@app.post("/v1/tts", dependencies=[Depends(require_auth)])
def tts(req: TtsRequest) -> Response:
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="empty text")
    if len(text) > 2000:
        raise HTTPException(status_code=400, detail="text too long (<=2000 chars)")
    speed = min(2.0, max(0.5, req.speed or 1.0))
    if FAKE:
        return Response(content=_silent_wav(), media_type="audio/wav")
    req_voice = (req.voice or "").strip() or None
    if req_voice and not _piper_onnx(req_voice).exists():
        req_voice = None  # 未知音色回退默认
    if not _has_piper():
        raise HTTPException(status_code=501, detail=f"piper voice missing: {_piper_onnx()}")
    import io
    import wave
    try:
        voice = _get_piper(req_voice)
        buf = io.BytesIO()
        # piper-tts 的两代 API：1.3+ 为 synthesize_wav，1.2 为 synthesize(text, wav)
        if hasattr(voice, "synthesize_wav"):
            syn_config = None
            if abs(speed - 1.0) > 1e-3:
                try:
                    from piper import SynthesisConfig  # 1.3+
                    syn_config = SynthesisConfig(length_scale=speed)
                except Exception:  # noqa: BLE001
                    syn_config = None
            with wave.open(buf, "wb") as wav:
                if syn_config is not None:
                    voice.synthesize_wav(text, wav, syn_config=syn_config)
                else:
                    voice.synthesize_wav(text, wav)
        else:
            with wave.open(buf, "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(getattr(voice.config, "sample_rate", 22050))
                try:
                    voice.synthesize(text, wav, length_scale=speed)
                except TypeError:
                    voice.synthesize(text, wav)
        data = buf.getvalue()
        if len(data) < 1000:
            raise RuntimeError(f"synthesized only {len(data)} bytes")
        return Response(content=_pad_wav(data), media_type="audio/wav")
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001 — 细节透给客户端便于排查
        raise HTTPException(status_code=500, detail=f"piper failed: {type(e).__name__}: {e}")
