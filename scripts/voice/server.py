"""Resident Italian voice for the companion apps.

Kokoro-82M: small enough to run on the CPU this box has, good enough that the reply
sounds spoken rather than announced. Loading costs a few seconds, so the model stays in
memory and answers over loopback instead of being loaded per sentence.

Bound to 127.0.0.1 and unauthenticated by design — the only caller is the Iva route on
the same machine, which does check the app's bearer. Nothing here reaches the network.

A voice conversion pass (RVC) was tried on top of this and dropped: on a CPU it cost
roughly a second per second of speech, ate 3 GB on an 8 GB box with no swap, and the
result was not worth either.
"""

from __future__ import annotations

import io
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import soundfile as sf

HOST = "127.0.0.1"
PORT = int(os.environ.get("IVA_VOICE_PORT", "8730"))
# Kokoro's Italian voices: if_sara (female), im_nicola (male).
VOICE = os.environ.get("IVA_VOICE", "if_sara")
RATE = 24_000
# A reply longer than this is a wall of text, not something to listen to.
MAX_CHARS = int(os.environ.get("IVA_VOICE_MAX_CHARS", "1200"))

pipeline = None
# One model, one synthesis at a time: a second turn would rather wait a moment than
# interleave with the first.
lock = threading.Lock()


def synthesise(text: str) -> np.ndarray:
    pieces = [audio for _, _, audio in pipeline(text, voice=VOICE)]
    if not pieces:
        raise ValueError("nessun audio prodotto")
    return np.concatenate(pieces)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:
        print(f"[voice] {fmt % args}", file=sys.stderr, flush=True)

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        self._send(status, json.dumps({"error": message}).encode(), "application/json")

    def do_GET(self) -> None:  # noqa: N802 — BaseHTTPRequestHandler's naming
        if self.path == "/health":
            ready = pipeline is not None
            self._send(
                200 if ready else 503,
                json.dumps({"ready": ready, "voice": VOICE}).encode(),
                "application/json",
            )
            return
        self._error(404, "not found")

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/say":
            self._error(404, "not found")
            return
        if pipeline is None:
            self._error(503, "modello non ancora caricato")
            return
        length = int(self.headers.get("Content-Length") or 0)
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
            text = str(payload["text"]).strip()
        except (ValueError, KeyError, TypeError):
            self._error(400, "serve un JSON con 'text'")
            return
        if not text:
            self._error(400, "testo vuoto")
            return

        started = time.time()
        try:
            with lock:
                audio = synthesise(text[:MAX_CHARS])
        except Exception as failure:  # noqa: BLE001 — the app falls back to device TTS
            self.log_message("sintesi fallita: %s", failure)
            self._error(500, str(failure)[:200])
            return

        buffer = io.BytesIO()
        sf.write(buffer, audio, RATE, format="WAV")
        self.log_message(
            "%d caratteri -> %.1fs di audio in %.1fs",
            len(text),
            len(audio) / RATE,
            time.time() - started,
        )
        self._send(200, buffer.getvalue(), "audio/wav")


def main() -> None:
    global pipeline
    from kokoro import KPipeline

    started = time.time()
    print(f"[voice] carico Kokoro (voce {VOICE})…", file=sys.stderr, flush=True)
    pipeline = KPipeline(lang_code="i")
    # Warm the graph so the first reply of the day is not the slow one.
    synthesise("Pronta.")
    print(f"[voice] pronta in {time.time() - started:.1f}s", file=sys.stderr, flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
