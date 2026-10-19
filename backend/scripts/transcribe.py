#!/usr/bin/env python3
"""
faster-whisper transcription helper for the Telnyx dialer notetaker.

Usage:
    python3 transcribe.py <16k_mono_wav_path> [model_size]

Writes JSON to stdout: {"text": "...", "segments": [{"start":..,"end":..,"text":..}, ...]}

Notes (from Hermes environment notes):
  - faster-whisper av bug: pass a numpy float32 16k-mono array, not a file path.
  - soundfile reads the wav; ffmpeg (called by the Node service) already produces 16k mono PCM.
  - First run downloads the chosen Whisper model (default "base", ~140 MB).
"""

import sys
import json
import numpy as np
import soundfile as sf
from faster_whisper import WhisperModel


def main():
    if len(sys.argv) < 2:
        print("usage: python3 transcribe.py <wav_path> [model_size]", file=sys.stderr)
        sys.exit(2)

    wav_path = sys.argv[1]
    model_size = sys.argv[2] if len(sys.argv) > 2 else "base"

    audio, sr = sf.read(wav_path, dtype="float32")
    if sr != 16000:
        print(json.dumps({"error": f"sample rate {sr} Hz; expected 16000. Re-encode with: ffmpeg -i {wav_path} -ar 16000 -ac 1 out.wav"}),
              file=sys.stderr)
        sys.exit(3)
    if audio.ndim > 1:
        audio = audio.mean(axis=1).astype(np.float32)

    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    segments, info = model.transcribe(audio, language=None, vad_filter=True)

    out = {
        "language": info.language,
        "language_probability": round(float(info.language_probability), 3),
        "duration": round(float(info.duration), 3),
        "text": "",
        "segments": [],
    }
    texts = []
    for seg in segments:
        texts.append(seg.text)
        out["segments"].append({
            "start": round(float(seg.start), 3),
            "end": round(float(seg.end), 3),
            "text": seg.text,
        })
    out["text"] = " ".join(texts).strip()
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
