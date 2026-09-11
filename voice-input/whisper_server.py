#!/usr/bin/env python3
"""Worker de transcricao (faster-whisper) do plugin voice-input do DSH.

Protocolo: JSON por linha no stdin -> {"id": n, "audio": "/caminho/arquivo.wav"}
Resposta:  {"t": "result", "id": n, "ok": true, "text": "...", "ms": 123, ...}
Outras linhas: {"t": "ready", ...} no boot e {"t": "fatal", "error": "..."}.

O modelo fica residente entre requisicoes; o processo e encerrado pelo plugin
quando o harness desliga.

@module dsh-voice-input/whisper_server
"""
import argparse
import json
import os
import sys
import time


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def build_parser():
    parser = argparse.ArgumentParser(description="Worker faster-whisper (JSON-lines)")
    parser.add_argument("--model", default="small")
    parser.add_argument("--language", default="pt")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--beam-size", type=int, default=5)
    parser.add_argument("--model-dir", default="")
    parser.add_argument("--initial-prompt", default="")
    parser.add_argument("--cpu-threads", type=int, default=0)
    return parser


def main():
    args = build_parser().parse_args()

    model_dir = args.model_dir or os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")
    os.makedirs(model_dir, exist_ok=True)
    os.environ.setdefault("HF_HOME", model_dir)
    os.environ.setdefault("HUGGINGFACE_HUB_CACHE", os.path.join(model_dir, "hub"))
    # O protocolo Xet (hf-xet) trava nesta rede; o download classico por HTTPS
    # funciona. Remova a linha abaixo se quiser tentar o Xet de novo.
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    # Rede instavel: timeouts folgados evitam "read operation timed out" no meio
    # do download do modelo (padrao do huggingface_hub e 10s).
    os.environ.setdefault("HF_HUB_ETAG_TIMEOUT", "60")
    os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "60")

    try:
        from faster_whisper import WhisperModel
    except Exception as error:  # pragma: no cover - ambiente mal instalado
        emit({"t": "fatal", "error": "faster_whisper indisponivel: " + str(error)})
        return 2

    started = time.time()
    try:
        kwargs = {
            "device": args.device,
            "compute_type": args.compute_type,
            "download_root": model_dir,
        }
        if args.cpu_threads > 0:
            kwargs["cpu_threads"] = args.cpu_threads
        model = WhisperModel(args.model, **kwargs)
    except Exception as error:  # pragma: no cover - falha de download/VRAM
        emit({"t": "fatal", "error": "falha ao carregar o modelo: " + str(error)})
        return 3

    emit({
        "t": "ready",
        "model": args.model,
        "device": args.device,
        "computeType": args.compute_type,
        "modelDir": model_dir,
        "loadMs": int((time.time() - started) * 1000),
    })

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except Exception:
            emit({"t": "result", "id": None, "ok": False, "error": "json invalido"})
            continue

        if request.get("cmd") == "ping":
            emit({"t": "result", "id": request.get("id"), "ok": True, "pong": True})
            continue
        if request.get("cmd") == "shutdown":
            break

        audio = request.get("audio")
        request_id = request.get("id")
        begin = time.time()
        if not audio or not os.path.exists(audio):
            emit({"t": "result", "id": request_id, "ok": False, "error": "arquivo de audio ausente"})
            continue

        try:
            segments, info = model.transcribe(
                audio,
                language=request.get("language") or args.language or None,
                beam_size=args.beam_size,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 300},
                condition_on_previous_text=False,
                initial_prompt=args.initial_prompt or None,
            )
            text = " ".join(segment.text.strip() for segment in segments).strip()
            emit({
                "t": "result",
                "id": request_id,
                "ok": True,
                "text": text,
                "ms": int((time.time() - begin) * 1000),
                "duration": round(float(getattr(info, "duration", 0.0) or 0.0), 2),
                "language": getattr(info, "language", None),
                "probability": round(float(getattr(info, "language_probability", 0.0) or 0.0), 3),
            })
        except Exception as error:
            emit({"t": "result", "id": request_id, "ok": False, "error": str(error)})

    return 0


if __name__ == "__main__":
    sys.exit(main())
