import io
import os
import pytest
from fastapi.testclient import TestClient
import torch

from core.config import OUTPUTS_DIR
from services.audio_io import atomic_save_wav


SAMPLE_SRT = """1
00:00:01,000 --> 00:00:03,500
Xin chào các bạn.

2
00:00:04,000 --> 00:00:06,800
Chào mừng đến với VoiceStudio.
"""


@pytest.fixture()
def client():
    from main import app
    return TestClient(app, client=("127.0.0.1", 50000))


def test_srt_parse_endpoint(client):
    file_bytes = io.BytesIO(SAMPLE_SRT.encode("utf-8"))
    response = client.post(
        "/srt/parse",
        files={"file": ("test.srt", file_bytes, "text/plain")},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["filename"] == "test.srt"
    assert data["total_cues"] == 2
    assert len(data["cues"]) == 2
    assert data["cues"][0]["id"] == 1
    assert data["cues"][0]["start"] == 1.0
    assert data["cues"][0]["end"] == 3.5
    assert data["cues"][0]["text"] == "Xin chào các bạn."
    assert data["cues"][1]["id"] == 2
    assert data["cues"][1]["start"] == 4.0
    assert data["cues"][1]["end"] == 6.8
    assert data["total_duration"] == 6.8


def test_srt_assemble_endpoint(client, tmp_path):
    # Create two dummy wav files in OUTPUTS_DIR
    sr = 24000
    wav1 = torch.zeros(1, sr * 2)  # 2s audio
    wav2 = torch.zeros(1, int(sr * 2.5))  # 2.5s audio

    file1 = "test_cue_1.wav"
    file2 = "test_cue_2.wav"
    atomic_save_wav(os.path.join(OUTPUTS_DIR, file1), wav1, sr)
    atomic_save_wav(os.path.join(OUTPUTS_DIR, file2), wav2, sr)

    try:
        payload = {
            "cues": [
                {"id": 1, "start": 1.0, "end": 3.0, "audio_url": f"/audio/{file1}"},
                {"id": 2, "start": 4.0, "end": 6.5, "audio_url": f"/audio/{file2}"},
            ],
            "timing_mode": "strict_fit",
            "total_duration": 7.0,
        }

        response = client.post("/srt/assemble", json=payload)
        assert response.status_code == 200
        data = response.json()
        assert "audio_url" in data
        assert data["duration"] >= 6.5
        assert data["filename"].startswith("srt_voice_")
        assert os.path.exists(os.path.join(OUTPUTS_DIR, data["filename"]))
    finally:
        for f in (file1, file2):
            p = os.path.join(OUTPUTS_DIR, f)
            if os.path.exists(p):
                os.unlink(p)
