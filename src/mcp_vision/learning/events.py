"""Learning events, contract v1 - the only thing that ever leaves a session.

One event is a fact about a task: a session began, a task started, a hint was
asked for, an attempt was submitted, a task finished, a session ended. The
shape is shared with the web/PWA and the browser extension so one teacher
dashboard can read all three:

    eventId        a uuid4, so a replayed export never double-counts
    schemaVersion  1
    sessionId      a uuid4 per opted-in session
    studentId      pseudonymous and local (see ``pseudonym``); never a name
    classId        optional, set only when a class code was entered
    timestamp      ISO-8601 with an offset
    platform       windows | chromebook | extension
    type           one of EVENT_TYPES
    taskId         required for task_started and task_completed, optional otherwise
    conceptIds     list of short concept slugs
    evidence       optional: attempts, hintCount, outcome, durationMs, studentConfirmed
    shareWithTeacher  bool

What an event may not carry is enforced here, not by convention:
``build`` drops any extra key and rejects the ones that would turn an event
into surveillance - screenshots, URLs, window titles, transcripts, prompt or
answer text, keystrokes. If a caller tries, it gets a ``ValueError`` naming
the field. The JSON schema itself lives in the shared ``contracts/``
directory, owned by the web/PWA side; ``FIELDS`` and ``EVIDENCE_FIELDS`` here
are the Python mirror of it and ``contract_summary()`` prints what this build
believes, so a drift between the two is visible rather than silent.
"""
from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

SCHEMA_VERSION = 1

EVENT_TYPES = ("session_started", "task_started", "hint_requested", "attempt_submitted",
               "task_completed", "session_ended")
PLATFORMS = ("windows", "chromebook", "extension")

FIELDS = ("eventId", "schemaVersion", "sessionId", "studentId", "classId", "timestamp", "platform",
          "type", "taskId", "conceptIds", "evidence", "shareWithTeacher")
EVIDENCE_FIELDS = ("attempts", "hintCount", "outcome", "durationMs", "studentConfirmed")
# Exactly the enum in contracts/learning-event.schema.json. There is deliberately no
# "unknown": an outcome nobody reported is an *absent* outcome, and recording one would
# be a claim about nothing. tests/windows/test_learning_events.py holds this to the
# contract file, so the two cannot drift apart in silence again.
OUTCOMES = ("correct", "incorrect", "partial", "skipped", "completed", "incomplete", "abandoned")

# Keys that must never appear in a learning event, with the reason. Checked by name and
# by suffix so ``answerText`` and ``promptText`` are caught along with ``text``.
FORBIDDEN = {
    "screenshot": "raw screen pixels",
    "screenshots": "raw screen pixels",
    "image": "raw screen pixels",
    "url": "browsing history",
    "urls": "browsing history",
    "href": "browsing history",
    "domain": "browsing history",
    "title": "window and page titles",
    "window": "window and page titles",
    "transcript": "what the student said",
    "prompt": "what was sent to the model",
    "answer": "what the model replied",
    "response": "what the model replied",
    "text": "free text",
    "content": "free text",
    "keystrokes": "typing",
    "keys": "typing",
    "selection": "whatever was selected on screen",
    "clipboard": "the clipboard",
    "email": "contact details",
    "name": "the student's name",
    "studentName": "the student's name",
}
_FORBIDDEN_SUFFIXES = ("text", "transcript", "prompt", "answer", "url", "screenshot", "name",
                       "title", "selection", "clipboard", "keystrokes")

MAX_CONCEPTS = 12
MAX_ID = 64


class ContractError(ValueError):
    """An event that would break contract v1, with the field named."""


def now_iso(clock=None) -> str:
    moment = clock() if clock is not None else datetime.now(timezone.utc)
    return moment.isoformat(timespec="seconds")


def _forbidden_reason(key: str) -> str | None:
    if key in FORBIDDEN:
        return FORBIDDEN[key]
    lowered = key.lower()
    for suffix in _FORBIDDEN_SUFFIXES:
        if lowered.endswith(suffix) and lowered not in {"eventid", "sessionid", "studentid", "classid", "taskid"}:
            return FORBIDDEN.get(suffix, "free text")
    return None


def check_payload(payload: dict[str, Any]) -> None:
    """Raise if anything in ``payload`` (at any depth) is a field events may not carry."""
    stack: list[tuple[str, Any]] = [("", payload)]
    while stack:
        path, value = stack.pop()
        if isinstance(value, dict):
            for key, inner in value.items():
                reason = _forbidden_reason(str(key))
                if reason is not None:
                    where = f"{path}.{key}" if path else str(key)
                    raise ContractError(
                        f"a learning event may not carry {where!r}: that is {reason}. "
                        "Learning events are counts and concept ids only.")
                stack.append((f"{path}.{key}" if path else str(key), inner))
        elif isinstance(value, (list, tuple)):
            for index, inner in enumerate(value):
                stack.append((f"{path}[{index}]", inner))


def _slug(value: Any, limit: int = MAX_ID) -> str:
    text = " ".join(str(value or "").split())
    return text[:limit]


def clean_evidence(evidence: dict[str, Any] | None) -> dict[str, Any] | None:
    """Keep only the five measured fields, typed. ``None`` when there is nothing to say."""
    if not evidence:
        return None
    check_payload(evidence)
    kept: dict[str, Any] = {}
    for key in EVIDENCE_FIELDS:
        if key not in evidence or evidence[key] is None:
            continue
        value = evidence[key]
        if key in {"attempts", "hintCount"}:
            kept[key] = max(0, int(value))
        elif key == "durationMs":
            kept[key] = max(0, int(value))
        elif key == "studentConfirmed":
            kept[key] = bool(value)
        else:
            # An outcome we do not recognise is dropped, not rewritten. Coercing it to a
            # placeholder would turn "we were not told" into a recorded claim, and the
            # dashboard's schema would refuse the event anyway.
            outcome = _slug(value, 20)
            if outcome in OUTCOMES:
                kept[key] = outcome
    return kept or None


@dataclass(frozen=True)
class LearningEvent:
    sessionId: str
    studentId: str
    type: str
    timestamp: str
    platform: str = "windows"
    schemaVersion: int = SCHEMA_VERSION
    eventId: str = ""
    classId: str | None = None
    taskId: str | None = None
    conceptIds: tuple[str, ...] = ()
    evidence: dict[str, Any] | None = None
    shareWithTeacher: bool = False

    def as_dict(self) -> dict[str, Any]:
        """Contract order, optional keys omitted when empty."""
        out: dict[str, Any] = {
            "eventId": self.eventId, "schemaVersion": self.schemaVersion, "sessionId": self.sessionId,
            "studentId": self.studentId, "timestamp": self.timestamp, "platform": self.platform,
            "type": self.type, "conceptIds": list(self.conceptIds),
            "shareWithTeacher": bool(self.shareWithTeacher),
        }
        if self.classId:
            out["classId"] = self.classId
        if self.taskId:
            out["taskId"] = self.taskId
        if self.evidence:
            out["evidence"] = dict(self.evidence)
        return {key: out[key] for key in FIELDS if key in out}

    def as_json(self) -> str:
        return json.dumps(self.as_dict(), ensure_ascii=False, sort_keys=False)


def build(*, session_id: str, student_id: str, type: str, platform: str = "windows",
          class_id: str | None = None, task_id: str | None = None,
          concept_ids: Any = (), evidence: dict[str, Any] | None = None,
          share_with_teacher: bool = False, event_id: str | None = None, clock=None) -> LearningEvent:
    """One validated event, or ``ContractError`` saying exactly what was wrong."""
    if type not in EVENT_TYPES:
        raise ContractError(f"{type!r} is not a contract v1 event type; expected one of {', '.join(EVENT_TYPES)}")
    if platform not in PLATFORMS:
        raise ContractError(f"{platform!r} is not a known platform; expected one of {', '.join(PLATFORMS)}")
    if not session_id or not student_id:
        raise ContractError("an event needs a sessionId and a pseudonymous studentId")
    if evidence is not None:
        check_payload(evidence)
    concepts = tuple(dict.fromkeys(_slug(item, 48) for item in (concept_ids or ()) if _slug(item)))[:MAX_CONCEPTS]
    return LearningEvent(
        eventId=event_id or str(uuid.uuid4()),
        sessionId=_slug(session_id),
        studentId=_slug(student_id),
        classId=_slug(class_id) or None if class_id else None,
        taskId=_slug(task_id) or None if task_id else None,
        timestamp=now_iso(clock),
        platform=platform,
        type=type,
        conceptIds=concepts,
        evidence=clean_evidence(evidence),
        shareWithTeacher=bool(share_with_teacher),
    )


def parse(line: str) -> LearningEvent | None:
    """Read one JSON Lines record back. ``None`` for a line this build can't trust."""
    try:
        data = json.loads(line)
    except (TypeError, ValueError):
        return None
    if not isinstance(data, dict) or int(data.get("schemaVersion", 0)) != SCHEMA_VERSION:
        return None
    if data.get("type") not in EVENT_TYPES:
        return None
    try:
        check_payload({key: value for key, value in data.items() if key not in FIELDS} or {})
    except ContractError:
        return None
    return LearningEvent(
        eventId=str(data.get("eventId") or ""), sessionId=str(data.get("sessionId") or ""),
        studentId=str(data.get("studentId") or ""), classId=data.get("classId") or None,
        taskId=data.get("taskId") or None, timestamp=str(data.get("timestamp") or ""),
        platform=str(data.get("platform") or "windows"), type=str(data["type"]),
        conceptIds=tuple(str(item) for item in (data.get("conceptIds") or [])),
        evidence=clean_evidence(data.get("evidence")),
        shareWithTeacher=bool(data.get("shareWithTeacher")),
    )


def contract_summary() -> dict[str, Any]:
    """What this build believes contract v1 is; compare against ``contracts/``."""
    return {"schemaVersion": SCHEMA_VERSION, "fields": list(FIELDS), "types": list(EVENT_TYPES),
            "platforms": list(PLATFORMS), "evidence": list(EVIDENCE_FIELDS), "outcomes": list(OUTCOMES),
            "forbidden": sorted(FORBIDDEN)}


__all__ = ["EVENT_TYPES", "EVIDENCE_FIELDS", "FIELDS", "FORBIDDEN", "OUTCOMES", "PLATFORMS", "SCHEMA_VERSION",
           "ContractError", "LearningEvent", "build", "check_payload", "clean_evidence", "contract_summary",
           "now_iso", "parse"]
