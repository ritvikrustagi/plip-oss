"""A learning session: the only thing that writes learning events.

``LearningSession`` wraps a ``SessionConsent`` and a ``LearningLog`` so the
rules live in one place:

* nothing is written before ``start``, and ``start`` needs an explicit yes;
* a paused session writes nothing at all;
* ``shareWithTeacher`` on an event is the session switch at the moment the
  event happened, never re-derived later;
* ``studentId`` is a local pseudonym (see ``pseudonym``), so the log is
  useless to anyone who doesn't also hold the machine.

Hooking it to the assistant: ``task_started`` when a task begins,
``hint_requested`` each time Plip is asked for help on it,
``attempt_submitted`` when the student says they tried, ``task_completed``
with the outcome. Only ``attempt_submitted`` and ``task_completed`` carry an
outcome, and ``studentConfirmed`` records whether the student said so
themselves or Plip inferred it - the summary keeps those apart.
"""
from __future__ import annotations

import hashlib
import os
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from mcp_vision.learning import events as contract
from mcp_vision.learning.consent import SessionConsent
from mcp_vision.learning.log import LearningLog

PSEUDONYM_FILE = "learning-id"


def pseudonym(path: Path | None = None) -> str:
    """A stable per-machine student id that is not derived from anything personal.

    A random 16-byte secret written once, hashed into a short readable id. It
    never contains a name, a login, a hostname or a MAC address, so an export
    cannot be walked back to a person without this machine's file.
    """
    if path is None:
        from mcp_vision.paths import state_dir

        path = state_dir() / PSEUDONYM_FILE
    path = Path(path)
    try:
        secret = path.read_bytes()
    except OSError:
        secret = os.urandom(16)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(secret)
            os.chmod(path, 0o600)
        except OSError:
            pass
    return "stu_" + hashlib.sha256(b"plip-learning-v1" + secret).hexdigest()[:16]


@dataclass
class LearningSession:
    """Records events for one opted-in session. Platform-neutral."""

    log: LearningLog = field(default_factory=LearningLog)
    consent: SessionConsent = field(default_factory=SessionConsent.load)
    student_id: str = ""
    platform: str = "windows"
    clock = staticmethod(time.monotonic)
    _tasks: dict[str, dict] = field(default_factory=dict, repr=False)

    def __post_init__(self) -> None:
        self.student_id = self.student_id or pseudonym()

    # -- the session ---------------------------------------------------------
    def start(self, *, granted_by: str = "student", class_id: str = "", screenshots: bool = False,
              screen_context: bool = False, share_with_teacher: bool = False,
              note: str = "") -> contract.LearningEvent:
        """Begin recording. Raises ``ValueError`` if ``granted_by`` isn't a real grant."""
        self.consent.start(granted_by=granted_by, class_id=class_id, screenshots=screenshots,
                           screen_context=screen_context, share_with_teacher=share_with_teacher, note=note)
        self.consent.save()
        self._tasks.clear()
        return self._write("session_started")

    def pause(self) -> None:
        self.consent.pause()
        self.consent.save()

    def resume(self) -> None:
        self.consent.resume()
        self.consent.save()

    def stop(self) -> contract.LearningEvent | None:
        """End the session. The closing event is written before consent drops."""
        event = self._write("session_ended") if self.consent.active else None
        self.consent.stop()
        self.consent.save()
        self._tasks.clear()
        return event

    def set(self, what: str, value: bool) -> None:
        self.consent.set(what, value)
        self.consent.save()

    # -- tasks ---------------------------------------------------------------
    def task_started(self, task_id: str = "", concept_ids=()) -> contract.LearningEvent | None:
        task_id = task_id or f"task_{uuid.uuid4().hex[:8]}"
        self._tasks[task_id] = {"at": self.clock(), "hints": 0, "attempts": 0,
                                "concepts": tuple(concept_ids or ())}
        return self._write("task_started", task_id=task_id, concept_ids=concept_ids)

    def hint_requested(self, task_id: str = "", concept_ids=()) -> contract.LearningEvent | None:
        task = self._task(task_id)
        if task is not None:
            task["hints"] += 1
        return self._write("hint_requested", task_id=task_id, concept_ids=concept_ids or self._concepts(task_id),
                           evidence={"hintCount": task["hints"] if task else 1})

    def attempt_submitted(self, task_id: str = "", *, outcome: str = "unknown",
                          student_confirmed: bool = False, concept_ids=()) -> contract.LearningEvent | None:
        task = self._task(task_id)
        if task is not None:
            task["attempts"] += 1
        return self._write("attempt_submitted", task_id=task_id,
                           concept_ids=concept_ids or self._concepts(task_id),
                           evidence={"attempts": task["attempts"] if task else 1, "outcome": outcome,
                                     "studentConfirmed": student_confirmed})

    def task_completed(self, task_id: str = "", *, outcome: str = "correct", student_confirmed: bool = False,
                       concept_ids=()) -> contract.LearningEvent | None:
        task = self._task(task_id)
        duration = int((self.clock() - task["at"]) * 1000) if task else None
        event = self._write("task_completed", task_id=task_id,
                            concept_ids=concept_ids or self._concepts(task_id),
                            evidence={"attempts": task["attempts"] if task else None,
                                      "hintCount": task["hints"] if task else None,
                                      "outcome": outcome, "durationMs": duration,
                                      "studentConfirmed": student_confirmed})
        self._tasks.pop(task_id, None)
        return event

    # -- internals -----------------------------------------------------------
    def _task(self, task_id: str) -> dict | None:
        if task_id:
            return self._tasks.get(task_id)
        return next(iter(self._tasks.values()), None) if len(self._tasks) == 1 else None

    def _concepts(self, task_id: str):
        task = self._task(task_id)
        return task["concepts"] if task else ()

    def _write(self, kind: str, **extra) -> contract.LearningEvent | None:
        """Build and append one event, or ``None`` when consent doesn't allow it."""
        if not self.consent.allows("events"):
            return None
        event = contract.build(
            session_id=self.consent.session_id, student_id=self.student_id, type=kind,
            platform=self.platform, class_id=self.consent.class_id or None,
            share_with_teacher=self.consent.share_with_teacher, **extra)
        return self.log.append(event)

    # -- the student's own controls ------------------------------------------
    def export(self) -> str:
        return self.log.export()

    def forget_everything(self) -> int:
        """Delete the log, the pseudonym and the consent record. Returns events removed."""
        gone = self.log.delete_all()
        SessionConsent.revoke_all()
        self.consent = SessionConsent()
        from mcp_vision.paths import state_dir

        try:
            (state_dir() / PSEUDONYM_FILE).unlink()
        except OSError:
            pass
        return gone


__all__ = ["PSEUDONYM_FILE", "LearningSession", "pseudonym"]
