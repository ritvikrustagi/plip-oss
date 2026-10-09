"""The learning-event log: append-only JSON Lines on this machine.

Minimal retention is the default, not an option: ``LearningLog`` trims
anything older than ``max_age_days`` (30) every time it writes, and
``delete_all`` removes the file outright. ``export`` hands back the same JSON
Lines so a student or a school can take it elsewhere, and ``export_for_teacher``
hands back only what is actually eligible - see ``eligible``.

Eligibility has two gates and both have to pass:

1. the event was recorded with ``shareWithTeacher`` true, which only happens
   while that switch was on in the session, and
2. the reader is authorised for the class the event names.

A roster the caller does not pass is not a permissive default: with no
``allowed_classes`` nothing is eligible, because an unauthorised reader is
the case this function exists for.
"""
from __future__ import annotations

import json
import time
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from mcp_vision.learning.events import LearningEvent, parse

DEFAULT_MAX_AGE_DAYS = 30
LOG_FILE = "learning-events.jsonl"


def _default_path() -> Path:
    from mcp_vision.paths import state_dir

    return state_dir() / LOG_FILE


def event_age_days(event: LearningEvent, now: float | None = None) -> float:
    """Days since the event. ``inf`` when the timestamp can't be read, so it is kept."""
    try:
        moment = datetime.fromisoformat(event.timestamp)
    except (TypeError, ValueError):
        return 0.0
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    seconds = (now if now is not None else time.time()) - moment.timestamp()
    return seconds / 86400.0


@dataclass
class LearningLog:
    path: Path = field(default_factory=_default_path)
    max_age_days: int = DEFAULT_MAX_AGE_DAYS
    clock = staticmethod(time.time)

    def __post_init__(self) -> None:
        self.path = Path(self.path)        # callers hand over strings; everything below wants a Path

    # -- writing --------------------------------------------------------------
    def append(self, event: LearningEvent) -> LearningEvent:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(event.as_json() + "\n")
        self.trim()
        return event

    def extend(self, events: Iterable[LearningEvent]) -> int:
        count = 0
        for event in events:
            self.append(event)
            count += 1
        return count

    def trim(self, now: float | None = None) -> int:
        """Drop events past the retention window. Returns how many were removed."""
        if self.max_age_days <= 0:
            return 0
        kept, dropped = [], 0
        for event in self.events():
            if event_age_days(event, now if now is not None else self.clock()) > self.max_age_days:
                dropped += 1
            else:
                kept.append(event)
        if dropped:
            self._rewrite(kept)
        return dropped

    def _rewrite(self, events: Sequence[LearningEvent]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text("".join(event.as_json() + "\n" for event in events), encoding="utf-8")

    # -- reading --------------------------------------------------------------
    def events(self) -> list[LearningEvent]:
        try:
            lines = self.path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return []
        return [event for event in (parse(line) for line in lines if line.strip()) if event is not None]

    def sessions(self) -> list[str]:
        seen: dict[str, None] = {}
        for event in self.events():
            seen.setdefault(event.sessionId, None)
        return list(seen)

    # -- what a student can do with their own data ----------------------------
    def export(self) -> str:
        """Everything, as JSON Lines. The student's own copy."""
        return "".join(event.as_json() + "\n" for event in self.events())

    def export_json(self) -> str:
        """The same, as one indented JSON array - easier to hand to a school."""
        return json.dumps([event.as_dict() for event in self.events()], indent=2, ensure_ascii=False)

    def delete_all(self) -> int:
        """Remove the log. Returns how many events went."""
        count = len(self.events())
        try:
            self.path.unlink()
        except OSError:
            pass
        return count

    def delete_session(self, session_id: str) -> int:
        kept = [event for event in self.events() if event.sessionId != session_id]
        gone = len(self.events()) - len(kept)
        if gone:
            self._rewrite(kept)
        return gone

    # -- what a teacher may read ---------------------------------------------
    def eligible(self, *, allowed_classes: Sequence[str] | None = None,
                 student_ids: Sequence[str] | None = None) -> list[LearningEvent]:
        """Opted-in events from classes this reader is authorised for.

        No roster means nothing is eligible: a teacher view is built from an
        explicit class list, and an empty list is an unauthorised reader.
        """
        classes = {str(item) for item in (allowed_classes or ()) if str(item)}
        students = {str(item) for item in (student_ids or ()) if str(item)}
        out = []
        for event in self.events():
            if not event.shareWithTeacher:
                continue
            if not event.classId or event.classId not in classes:
                continue
            if students and event.studentId not in students:
                continue
            out.append(event)
        return out

    def export_for_teacher(self, *, allowed_classes: Sequence[str] | None = None,
                           student_ids: Sequence[str] | None = None) -> str:
        return "".join(event.as_json() + "\n"
                       for event in self.eligible(allowed_classes=allowed_classes, student_ids=student_ids))


__all__ = ["DEFAULT_MAX_AGE_DAYS", "LOG_FILE", "LearningLog", "event_age_days"]
