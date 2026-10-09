"""A reference model proxy for the extension, for local development only.

The extension never holds a model key. This is the other half of that: a tiny
server that holds the key, decides which model to call, and streams text back
in the shape src/lib/providers/proxy.js expects.

    export ANTHROPIC_API_KEY=...        # never committed, never sent to a client
    export DEEPGRAM_API_KEY=...         # optional, for POST /listen
    export PLIP_PROXY_TOKEN=dev-token   # what the student's panel sends
    python3 apps/extension/tools/dev_proxy.py

Then in the extension's settings: provider "School model proxy", URL
http://localhost:8787/chat, token dev-token. For voice, set speaking to
"Through my school's server"; the transcription URL is derived as
http://localhost:8787/listen.

Two routes:
    POST /chat    {"system", "messages"}  -> text/event-stream of {"text"}
    POST /listen  raw audio bytes         -> {"text"}  (via Deepgram)

What this is not: a production service. A real deployment needs real identity
(a per-student token your SIS issues, not one shared secret), rate limits, a
request log policy, and a review of what the system prompt allows. It is here
so the proxy contract is executable rather than described.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = os.environ.get("PLIP_PROXY_MODEL", "claude-opus-5-5")
SPEECH_URL = "https://api.deepgram.com/v1/listen"
MAX_AUDIO_BYTES = 8 * 1024 * 1024        # about ten minutes of opus; a turn is seconds
EFFORT = os.environ.get("PLIP_PROXY_EFFORT", "low")
MAX_TOKENS = 4000
PORT = int(os.environ.get("PLIP_PROXY_PORT", "8787"))


# Read when a request arrives, not when the module loads, so a deployment (or a
# test) can set these around a running server.
def speech_url() -> str:
    """Deepgram by default; override for the EU endpoint, a self-hosted one, or a test."""
    return os.environ.get("PLIP_SPEECH_URL", SPEECH_URL)


def speech_model() -> str:
    """Deepgram's current general model. Set PLIP_SPEECH_MODEL if the name moves on."""
    return os.environ.get("PLIP_SPEECH_MODEL", "nova-3")


def speech_key() -> str:
    return os.environ.get("DEEPGRAM_API_KEY", "")


def proxy_token() -> str:
    return os.environ.get("PLIP_PROXY_TOKEN", "")
# The panel's own system prompt is sent with the request. A real deployment
# should pin its own instead of trusting the client's.
TRUST_CLIENT_SYSTEM = os.environ.get("PLIP_PROXY_TRUST_CLIENT_SYSTEM", "1") == "1"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):      # one line per request, no bodies
        sys.stderr.write(f"[dev_proxy] {fmt % args}\n")

    def do_OPTIONS(self):                    # noqa: N802 - the API is Chrome's
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):                       # noqa: N802
        token = proxy_token()
        if token and self.headers.get("authorization", "") != f"Bearer {token}":
            self._json(401, {"error": "bad token"})
            return
        if self.path.rstrip("/").endswith("/listen"):
            self._listen()
            return
        length = int(self.headers.get("content-length") or 0)
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            self._json(400, {"error": "bad json"})
            return
        messages = [
            {"role": turn["role"], "content": str(turn.get("content") or "")}
            for turn in payload.get("messages") or []
            if turn.get("role") in {"user", "assistant"} and str(turn.get("content") or "").strip()
        ]
        if not messages:
            self._json(400, {"error": "no messages"})
            return
        system = payload.get("system") if TRUST_CLIENT_SYSTEM else ""
        try:
            self._stream(system, messages)
        except Exception as exc:             # the student sees a sentence, not a stack
            self._json(502, {"error": f"{type(exc).__name__}: {exc}"[:200]})

    def _listen(self) -> None:
        """One recorded clip -> words, with the speech key held here.

        The audio is read, forwarded, and dropped. Nothing is written to disk,
        and the clip is never logged: it is a child's voice.
        """
        key = speech_key()
        if not key:
            self._json(503, {"error": "this server has no speech key set, so voice is off"})
            return
        length = int(self.headers.get("content-length") or 0)
        if length <= 0:
            self._json(400, {"error": "no audio"})
            return
        if length > MAX_AUDIO_BYTES:
            self._json(413, {"error": "that clip is too long"})
            return
        audio = self.rfile.read(length)
        content_type = self.headers.get("content-type") or "audio/webm"
        query = urllib.parse.urlencode({"model": speech_model(), "smart_format": "true", "punctuate": "true"})
        request = urllib.request.Request(
            f"{speech_url()}?{query}",
            data=audio,
            headers={"Authorization": f"Token {key}", "Content-Type": content_type},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                body = json.loads(response.read())
        except urllib.error.HTTPError as exc:
            self._json(502, {"error": f"the speech service said {exc.code}"})
            return
        except Exception as exc:
            self._json(502, {"error": f"{type(exc).__name__}"})
            return
        alternatives = (body.get("results", {}).get("channels") or [{}])[0].get("alternatives") or [{}]
        self._json(200, {"text": str(alternatives[0].get("transcript") or "").strip()})

    def _stream(self, system: str, messages: list[dict]) -> None:
        import anthropic                      # imported late so --help works without it

        client = anthropic.Anthropic()        # reads ANTHROPIC_API_KEY from the environment
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self._cors()
        self.end_headers()
        # Streaming keeps the panel responsive and avoids request timeouts.
        with client.messages.stream(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            system=([{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}]
                    if system else anthropic.NOT_GIVEN),
            messages=messages,
            output_config={"effort": EFFORT},
        ) as stream:
            for text in stream.text_stream:
                self._frame({"text": text})
        self._frame("[DONE]", raw=True)

    def _frame(self, payload, raw: bool = False) -> None:
        body = payload if raw else json.dumps(payload)
        self.wfile.write(f"data: {body}\n\n".encode())
        self.wfile.flush()

    def _json(self, status: int, body: dict) -> None:
        blob = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(blob)))
        self._cors()
        self.end_headers()
        self.wfile.write(blob)

    def _cors(self) -> None:
        # A side panel's requests come from chrome-extension://<id>, so the
        # browser needs this. Lock it to your extension id in a real deployment.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "authorization,content-type")


def main() -> int:
    if "--help" in sys.argv or "-h" in sys.argv:
        print(__doc__)
        return 0
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("set ANTHROPIC_API_KEY first (it stays on this machine)", file=sys.stderr)
        return 1
    if not proxy_token():
        print("warning: PLIP_PROXY_TOKEN is unset, so this proxy accepts anyone", file=sys.stderr)
    print(f"[dev_proxy] http://localhost:{PORT}/chat -> {MODEL} (effort {EFFORT})", file=sys.stderr)
    speech = speech_model() if speech_key() else "off (set DEEPGRAM_API_KEY)"
    print(f"[dev_proxy] http://localhost:{PORT}/listen -> deepgram {speech}", file=sys.stderr)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
