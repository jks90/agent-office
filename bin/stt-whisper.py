#!/usr/bin/env python3
"""STT local del Guide Agent (FT-9): transcribe audio con faster-whisper.

Uso:
  stt-whisper.py <audio> [idioma] [vocabulario]   una transcripción y sale (modo de siempre)
  stt-whisper.py --serve                          proceso persistente: carga el modelo UNA vez y atiende peticiones
                                                  por stdin, una por línea JSON {"id","file","lang","prompt"} →
                                                  stdout {"id","text","lang"} o {"id","error"}; la 1.ª línea es
                                                  {"ready":true,"model","device"}

Instalar: pip install faster-whisper       (PyAV, incluido, decodifica webm/opus)
GPU (NVIDIA): pip install nvidia-cublas-cu12 "nvidia-cudnn-cu12>=9,<10"  (se cargan solas; sin ellas, CPU)
Entorno: AO_WHISPER_MODEL (medium por defecto; base/small van más rápido y entienden peor),
         AO_WHISPER_DEVICE (auto por defecto: GPU si arranca, si no CPU; o cuda / cpu).
El vocabulario (initial_prompt) ayuda a que salgan bien los nombres propios: AgentOffice, flow-test, Revert…
"""
import ctypes
import glob
import json
import os
import site
import sys


def preload_cuda_libs():
    """Carga cuBLAS/cuDNN instalados con pip (paquetes nvidia-*) antes de ctranslate2, sin tocar LD_LIBRARY_PATH."""
    roots = list(getattr(site, "getsitepackages", lambda: [])()) + [site.getusersitepackages()]
    for root in roots:
        for sub in ("nvidia/cublas/lib", "nvidia/cudnn/lib"):
            for lib in sorted(glob.glob(os.path.join(root, sub, "lib*.so*"))):
                try:
                    ctypes.CDLL(lib, mode=ctypes.RTLD_GLOBAL)
                except OSError:
                    pass


preload_cuda_libs()
try:
    from faster_whisper import WhisperModel
except ImportError:
    sys.exit("Falta faster-whisper: pip install faster-whisper")

MODEL = os.environ.get("AO_WHISPER_MODEL", "medium")
WANT = os.environ.get("AO_WHISPER_DEVICE", "auto")


def load():
    """GPU si se pide o en «auto» y funciona de verdad (se prueba con un silencio); si no, CPU int8."""
    if WANT in ("auto", "cuda"):
        try:
            import numpy as np
            m = WhisperModel(MODEL, device="cuda", compute_type="float16")
            list(m.transcribe(np.zeros(16000, dtype=np.float32), language="es")[0])  # falla aquí si falta cuBLAS/cuDNN
            return m, "cuda"
        except Exception as e:  # noqa: BLE001
            if WANT == "cuda":
                raise
            print(f"GPU no disponible ({str(e)[:120]}): uso CPU", file=sys.stderr)
    return WhisperModel(MODEL, device="cpu", compute_type="int8"), "cpu"


def transcribe(model, path, lang=None, prompt=None):
    lang = None if lang in (None, "", "auto") else lang
    segments, _info = model.transcribe(path, language=lang, vad_filter=True, beam_size=5, initial_prompt=prompt or None)
    return " ".join(s.text.strip() for s in segments).strip()


def serve():
    model, device = load()
    print(json.dumps({"ready": True, "model": MODEL, "device": device}), flush=True)
    for line in sys.stdin:
        try:
            req = json.loads(line)
        except ValueError:
            continue
        try:
            text = transcribe(model, req["file"], req.get("lang"), req.get("prompt"))
            print(json.dumps({"id": req.get("id"), "text": text, "lang": req.get("lang")}), flush=True)
        except Exception as e:  # noqa: BLE001
            print(json.dumps({"id": req.get("id"), "error": str(e)[:300]}), flush=True)


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "--serve":
        serve()
        sys.exit(0)
    if len(sys.argv) < 2:
        sys.exit("Uso: stt-whisper.py <audio> [idioma] [vocabulario] | --serve")
    m, _dev = load()
    print(transcribe(m, sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None, sys.argv[3] if len(sys.argv) > 3 else None))
