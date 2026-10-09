"""The reference proxy's two routes, against a stand-in for the speech service.

The extension's own tests cover the browser half. This covers the half that
holds the keys: that /listen forwards a clip the way Deepgram documents it,
that the key never comes back down to the client, and that every refusal is a
status and a sentence rather than a stack trace.

No network and no credentials: a local stand-in answers in Deepgram's own
response shape, and PLIP_SPEECH_URL points the proxy at it. What this does not
and cannot check is whether the real service agrees with its documentation -
see docs/EXTENSION.md, "What is not verified".
"""
from __future__ import annotations

import importlib.util
import json
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

SOURCE = Path(__file__).resolve().parents[2] / "apps" / "extension" / "tools" / "dev_proxy.py"


def load_proxy_module():
    spec = importlib.util.spec_from_file_location("plip_dev_proxy", SOURCE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


dev_proxy = load_proxy_module()


class SpeechStub(BaseHTTPRequestHandler):
    """Stands in for Deepgram: records what it was sent, answers in its shape."""

    seen: dict = {}
    status = 200
    transcript = "how do I start question four"

    def log_message(self, fmt, *args):
        pass

    def do_POST(self):                        # noqa: N802
        length = int(self.headers.get("content-length") or 0)
        SpeechStub.seen = {
            "path": self.path,
            "authorization": self.headers.get("authorization", ""),
            "content_type": self.headers.get("content-type", ""),
            "body": self.rfile.read(length),
        }
        if SpeechStub.status != 200:
            self.send_response(SpeechStub.status)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        body = json.dumps({
            "metadata": {"request_id": "stub"},
            "results": {"channels": [{"alternatives": [{"transcript": SpeechStub.transcript}]}]},
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def serve(handler) -> tuple[ThreadingHTTPServer, str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_port}"


@pytest.fixture
def speech(monkeypatch):
    SpeechStub.seen, SpeechStub.status = {}, 200
    SpeechStub.transcript = "how do I start question four"
    server, base = serve(SpeechStub)
    monkeypatch.setenv("PLIP_SPEECH_URL", f"{base}/v1/listen")
    yield SpeechStub
    server.shutdown()


@pytest.fixture
def proxy(monkeypatch):
    monkeypatch.setenv("DEEPGRAM_API_KEY", "stub-speech-key")
    monkeypatch.setenv("PLIP_PROXY_TOKEN", "class-token")
    server, base = serve(dev_proxy.Handler)
    yield base
    server.shutdown()


def post(url: str, body: bytes, *, token: str = "class-token", content_type: str = "audio/webm") -> tuple[int, dict]:
    headers = {"Content-Type": content_type}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


def test_a_clip_comes_back_as_words(proxy, speech):
    status, body = post(f"{proxy}/listen", b"fake opus bytes")
    assert status == 200
    assert body == {"text": "how do I start question four"}


def test_the_request_matches_what_deepgram_documents(proxy, speech):
    post(f"{proxy}/listen", b"fake opus bytes", content_type="audio/webm;codecs=opus")
    seen = speech.seen
    assert seen["authorization"] == "Token stub-speech-key"      # Token, not Bearer
    assert seen["content_type"] == "audio/webm;codecs=opus"      # passed through untouched
    assert seen["body"] == b"fake opus bytes"                    # the audio is the body
    assert "model=nova-3" in seen["path"]
    assert "smart_format=true" in seen["path"]
    assert "punctuate=true" in seen["path"]


def test_the_speech_key_never_goes_back_to_the_client(proxy, speech):
    _, body = post(f"{proxy}/listen", b"fake opus bytes")
    assert "stub-speech-key" not in json.dumps(body)


def test_the_model_is_configurable_without_touching_the_client(proxy, speech, monkeypatch):
    monkeypatch.setenv("PLIP_SPEECH_MODEL", "nova-9-imaginary")
    post(f"{proxy}/listen", b"fake opus bytes")
    assert "model=nova-9-imaginary" in speech.seen["path"]


def test_a_clip_with_nothing_in_it_comes_back_empty_not_broken(proxy, speech):
    speech.transcript = ""
    status, body = post(f"{proxy}/listen", b"silence")
    assert status == 200
    assert body == {"text": ""}


def test_without_a_speech_key_voice_is_off_and_says_so(proxy, speech, monkeypatch):
    monkeypatch.delenv("DEEPGRAM_API_KEY")
    status, body = post(f"{proxy}/listen", b"fake opus bytes")
    assert status == 503
    assert "speech key" in body["error"]


def test_a_wrong_session_token_is_refused_before_any_audio_is_forwarded(proxy, speech):
    status, body = post(f"{proxy}/listen", b"fake opus bytes", token="not-the-token")
    assert status == 401
    assert speech.seen == {}, "audio must not reach the speech service without a valid token"


def test_an_empty_post_is_refused(proxy, speech):
    status, body = post(f"{proxy}/listen", b"")
    assert status == 400
    assert speech.seen == {}


def test_an_oversized_clip_is_refused_before_it_is_forwarded(proxy, speech, monkeypatch):
    monkeypatch.setattr(dev_proxy, "MAX_AUDIO_BYTES", 16)
    status, body = post(f"{proxy}/listen", b"x" * 64)
    assert status == 413
    assert speech.seen == {}


def test_a_failing_speech_service_becomes_a_sentence_not_a_stack_trace(proxy, speech):
    speech.status = 429
    status, body = post(f"{proxy}/listen", b"fake opus bytes")
    assert status == 502
    assert body["error"] == "the speech service said 429"


def test_an_unreachable_speech_service_is_reported_not_hung(proxy, monkeypatch):
    monkeypatch.setenv("DEEPGRAM_API_KEY", "stub-speech-key")
    monkeypatch.setenv("PLIP_SPEECH_URL", "http://127.0.0.1:1/v1/listen")
    status, body = post(f"{proxy}/listen", b"fake opus bytes")
    assert status == 502
    assert body["error"]


def test_the_chat_route_still_refuses_an_empty_conversation(proxy):
    request = urllib.request.Request(
        f"{proxy}/chat",
        data=json.dumps({"messages": []}).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer class-token"},
        method="POST",
    )
    try:
        urllib.request.urlopen(request, timeout=10)
        raise AssertionError("an empty conversation should be refused")
    except urllib.error.HTTPError as exc:
        assert exc.code == 400
        assert json.loads(exc.read())["error"] == "no messages"
