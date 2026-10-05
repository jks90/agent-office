#!/usr/bin/env python3
"""STT local del Guide Agent (FT-9): transcribe un fichero de audio con faster-whisper.

Uso: stt-whisper.py <audio> [idioma]      (imprime el texto por stdout)
Instalar: pip install faster-whisper       (PyAV, incluido, decodifica webm/opus)
Variables: AO_WHISPER_MODEL (por defecto «base»), AO_WHISPER_DEVICE (cpu|cuda, por defecto cpu).
"""
import os
import sys

try:
    from faster_whisper import WhisperModel
except ImportError:
    sys.exit("Falta faster-whisper: pip install faster-whisper")

if len(sys.argv) < 2:
    sys.exit("Uso: stt-whisper.py <audio> [idioma]")

lang = (sys.argv[2] if len(sys.argv) > 2 else "") or None
if lang == "auto":
    lang = None
device = os.environ.get("AO_WHISPER_DEVICE", "cpu")
model = WhisperModel(os.environ.get("AO_WHISPER_MODEL", "base"), device=device, compute_type="int8" if device == "cpu" else "float16")
segments, _info = model.transcribe(sys.argv[1], language=lang, vad_filter=True)
print(" ".join(s.text.strip() for s in segments).strip())
