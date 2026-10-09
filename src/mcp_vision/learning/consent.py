"""Who said yes to what, this session.

Nothing in the learning layer runs on a default. A session has to be started
by hand, and three switches inside it are off until someone turns them on:

* ``screen_context`` - may Plip read the window map for grounding
* ``screenshots``    - may Plip capture pixels at all
* ``share_with_teacher`` - may events be marked eligible for a summary

``paused`` stops all three at once without ending the session, which is what
the shell's Pause button sets. ``stopped`` is the end: a stopped session never
answers yes again, so a stale reference can't quietly resume collection.

Consent lives in one small JSON file under the state directory, so the shell,
the CLI and a future service all read the same truth, and ``revoke_all``
deletes it. The file records who gave consent (``granted_by``: "student",
"teacher", "guardian") and when, because a school deployment has to be able to
show that - not as a compliance claim, as the record a compliance process
would need.
"""
from __future__ import annotations

import json
import time
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path

GRANTERS = ("student", "teacher", "guardian", "demo")
CONSENT_FILE = "learning-consent.json"


def _state_path(path: Path | str | None = None) -> Path:
    if path is not None:
        return Path(path)                  # a string is a perfectly ordinary thing to pass
    from mcp_vision.paths import state_dir

    return state_dir() / CONSENT_FILE


@dataclass
class SessionConsent:
    """The switches for one session. Everything optional is off."""

    session_id: str = ""
    started_at: float = 0.0
    granted_by: str = "student"
    class_id: str = ""
    screen_context: bool = False
    screenshots: bool = False
    share_with_teacher: bool = False
    paused: bool = False
    stopped: bool = True             # no session until someone starts one
    note: str = ""                   # what the person was told when they said yes

    # -- questions the rest of the app asks ------------------------------------
    @property
    def active(self) -> bool:
        return bool(self.session_id) and not self.stopped and not self.paused

    def allows(self, what: str) -> bool:
        """``what``: "screen_context" | "screenshots" | "share_with_teacher" | "events"."""
        if not self.active:
            return False
        if what == "events":
            return True
        return bool(getattr(self, what, False))

    def why_not(self, what: str) -> str:
        """The sentence to show where the thing is greyed out."""
        if not self.session_id or self.stopped:
            return "No learning session is running. Start one to switch this on."
        if self.paused:
            return "The session is paused. Resume it to switch this on."
        if not getattr(self, what, False):
            labels = {"screenshots": "Screenshots are off for this session.",
                      "screen_context": "Reading the window map is off for this session.",
                      "share_with_teacher": "Sharing with your teacher is off for this session."}
            return labels.get(what, f"{what} is off for this session.")
        return ""

    # -- changes -----------------------------------------------------------------
    def start(self, *, granted_by: str = "student", class_id: str = "", screen_context: bool = False,
              screenshots: bool = False, share_with_teacher: bool = False, note: str = "",
              clock=time.time) -> SessionConsent:
        if granted_by not in GRANTERS:
            raise ValueError(f"{granted_by!r} can't grant consent; expected one of {', '.join(GRANTERS)}")
        self.session_id = str(uuid.uuid4())
        self.started_at = clock()
        self.granted_by = granted_by
        self.class_id = " ".join(str(class_id or "").split())[:64]
        self.screen_context = bool(screen_context)
        self.screenshots = bool(screenshots)
        self.share_with_teacher = bool(share_with_teacher)
        self.paused = False
        self.stopped = False
        self.note = note[:300]
        return self

    def pause(self) -> SessionConsent:
        self.paused = True
        return self

    def resume(self) -> SessionConsent:
        if not self.stopped:
            self.paused = False
        return self

    def stop(self) -> SessionConsent:
        self.stopped = True
        self.paused = False
        self.screenshots = False
        self.screen_context = False
        self.share_with_teacher = False
        return self

    def set(self, what: str, value: bool) -> SessionConsent:
        if what not in {"screen_context", "screenshots", "share_with_teacher"}:
            raise ValueError(f"{what!r} isn't a session switch")
        if self.stopped:
            raise ValueError("No session is running, so there is nothing to switch.")
        setattr(self, what, bool(value))
        return self

    # -- disk ---------------------------------------------------------------------
    def save(self, path: Path | str | None = None) -> SessionConsent:
        target = _state_path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(asdict(self), indent=2), encoding="utf-8")
        return self

    @classmethod
    def load(cls, path: Path | str | None = None) -> SessionConsent:
        target = _state_path(path)
        try:
            data = json.loads(target.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return cls()
        known = {key: value for key, value in data.items() if key in cls.__dataclass_fields__}
        return cls(**known)

    @classmethod
    def revoke_all(cls, path: Path | str | None = None) -> SessionConsent:
        """Forget that consent was ever given. Used by "delete my data"."""
        target = _state_path(path)
        try:
            target.unlink()
        except OSError:
            pass
        return cls()

    def as_rows(self) -> list[dict]:
        """What the shell renders as switches, each with its own explanation."""
        return [
            {"id": "screen_context", "label": "Let Plip read the window map",
             "on": self.screen_context, "available": self.active,
             "detail": "Button and field names from the window in front. Never what you type."},
            {"id": "screenshots", "label": "Let Plip take screenshots",
             "on": self.screenshots, "available": self.active,
             "detail": "Only while this session runs, only to answer you. Nothing is uploaded or kept."},
            {"id": "share_with_teacher", "label": "Share progress with my teacher",
             "on": self.share_with_teacher, "available": self.active,
             "detail": "Counts and concept names only: tasks done, hints asked for. No text, no screens."},
        ]

    def summary(self) -> str:
        if not self.session_id or self.stopped:
            return "No session running."
        on = [name for name in ("screen_context", "screenshots", "share_with_teacher") if getattr(self, name)]
        state = "paused" if self.paused else "running"
        return f"Session {self.session_id[:8]} {state}; on: {', '.join(on) if on else 'nothing'}"


__all__ = ["CONSENT_FILE", "GRANTERS", "SessionConsent"]
