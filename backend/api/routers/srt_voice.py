"""SRT to Voice synthesis and assembly router."""
from __future__ import annotations

import logging
import os
import uuid
from typing import List, Optional

import torch
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel

from api.dependencies import require_consumer_reads_admin_writes
from core.config import OUTPUTS_DIR
from services.audio_io import atomic_save_wav, load_audio
from services.ffmpeg_utils import _pitch_preserving_stretch
from services.srt_parser import parse_srt
from services.watermark import mark_synthetic

logger = logging.getLogger("omnivoice.srt_voice")

router = APIRouter(prefix="/srt", tags=["srt-voice"], dependencies=[Depends(require_consumer_reads_admin_writes)])


class CueItem(BaseModel):
    id: int
    start: float
    end: float
    duration: float
    text: str
    speaker_id: Optional[str] = "Speaker 1"
    audio_url: Optional[str] = None


class SrtParseResponse(BaseModel):
    filename: str
    cues: List[CueItem]
    total_duration: float
    total_cues: int


class AssembleCueInput(BaseModel):
    id: int
    start: float
    end: float
    audio_url: str


class AssembleRequest(BaseModel):
    cues: List[AssembleCueInput]
    timing_mode: Optional[str] = "strict_fit"  # "strict_fit" | "natural"
    total_duration: Optional[float] = None


class AssembleResponse(BaseModel):
    audio_url: str
    duration: float
    filename: str


@router.post("/parse", response_model=SrtParseResponse)
async def parse_srt_endpoint(
    file: Optional[UploadFile] = File(None),
):
    if file is None:
        raise HTTPException(status_code=400, detail="No file provided")

    filename = file.filename or "subtitles.srt"
    content_bytes = await file.read()
    try:
        text = content_bytes.decode("utf-8")
    except UnicodeDecodeError:
        text = content_bytes.decode("latin-1", errors="replace")

    result = parse_srt(text)
    cues: List[CueItem] = []
    total_duration = 0.0
    for idx, seg in enumerate(result.segments, start=1):
        start = float(seg["start"])
        end = float(seg["end"])
        duration = max(0.0, round(end - start, 3))
        if end > total_duration:
            total_duration = end
        cues.append(
            CueItem(
                id=idx,
                start=round(start, 3),
                end=round(end, 3),
                duration=duration,
                text=str(seg["text"]).strip(),
                speaker_id=str(seg.get("speaker_id") or "Speaker 1"),
            )
        )

    return SrtParseResponse(
        filename=filename,
        cues=cues,
        total_duration=round(total_duration, 3),
        total_cues=len(cues),
    )


@router.post("/assemble", response_model=AssembleResponse)
async def assemble_srt_audio(req: AssembleRequest):
    if not req.cues:
        raise HTTPException(status_code=400, detail="No cues provided for assembly")

    sr = 24000
    loaded_items: list[tuple[AssembleCueInput, torch.Tensor]] = []

    for cue in req.cues:
        if not cue.audio_url:
            continue
        # Extract filename safely from /audio/take_xxx.wav or relative path
        raw_name = os.path.basename(cue.audio_url.split("?")[0])
        wav_path = os.path.join(OUTPUTS_DIR, raw_name)
        if not os.path.exists(wav_path):
            logger.warning("Cue %d audio file not found: %s", cue.id, wav_path)
            continue

        try:
            wav, file_sr = load_audio(wav_path)
            sr = file_sr
            if wav.shape[0] > 1:
                wav = wav.mean(dim=0, keepdim=True)

            # Fit to slot if strict_fit is requested
            cue_dur = max(0.05, cue.end - cue.start)
            target_samples = int(cue_dur * sr)
            if req.timing_mode == "strict_fit" and target_samples > 0 and wav.shape[-1] > target_samples:
                try:
                    wav = await _pitch_preserving_stretch(wav, target_samples, sr)
                except Exception as stretch_err:
                    logger.warning("Failed to stretch cue %d: %s", cue.id, stretch_err)

            loaded_items.append((cue, wav))
        except Exception as err:
            logger.error("Failed to load audio for cue %d: %s", cue.id, err)

    if not loaded_items:
        raise HTTPException(status_code=400, detail="Could not load audio for any cue")

    max_end = max(cue.end for cue, _ in loaded_items)
    max_audio_end = max(cue.start + (wav.shape[-1] / sr) for cue, wav in loaded_items)
    total_len_s = max(req.total_duration or 0.0, max_end, max_audio_end)
    total_samples = max(int(total_len_s * sr), 1)

    master_track = torch.zeros((1, total_samples), dtype=torch.float32)

    for cue, wav in loaded_items:
        start_sample = max(0, int(cue.start * sr))
        if start_sample >= total_samples:
            continue
        wl = wav.shape[-1]
        end_sample = min(start_sample + wl, total_samples)
        chunk_len = end_sample - start_sample
        if chunk_len > 0:
            master_track[:, start_sample:end_sample] += wav[:, :chunk_len]

    # Apply synthetic watermark
    master_track = mark_synthetic(master_track, sr, context="srt_voice.assemble")

    out_name = f"srt_voice_{uuid.uuid4().hex[:12]}.wav"
    out_path = os.path.join(OUTPUTS_DIR, out_name)
    atomic_save_wav(out_path, master_track, sr)

    return AssembleResponse(
        audio_url=f"/audio/{out_name}",
        duration=round(total_len_s, 3),
        filename=out_name,
    )
