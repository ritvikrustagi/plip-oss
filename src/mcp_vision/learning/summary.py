"""The teacher-facing summary, with measurement and inference kept apart.

``summarise`` takes eligible events (``LearningLog.eligible``) and returns a
report in two halves that are never mixed:

``measured``   counts that came straight off the event log. Tasks completed,
               hints asked for, attempts, concepts practised, wall-clock
               duration of a task. Every one of these is a thing the student
               did in the app.

``inferred``   the two judgement calls - where a student seemed to struggle,
               and what to try next - each carrying ``basis`` (the counts it
               came from) and ``confidence``. These are hypotheses for a
               teacher to check, and the wording says so.

What is deliberately absent, and what ``REFUSED_CLAIMS`` documents: attention,
engagement, effort, mastery, ability, and grades. This log cannot support any
of them. Time with the app open is time with the app open; it is not attention
and not learning, and nothing here converts one into the other.

A summary is only ever built from events a reader is authorised to see, so the
caller must pass ``allowed_classes``. ``summarise_log`` does both steps and is
the one to call.
"""
from __future__ import annotations

from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from mcp_vision.learning.events import LearningEvent

STRUGGLE_HINTS = 3            # hints on one task before it is worth a teacher's look
STRUGGLE_ATTEMPTS = 3         # attempts with no completion
LONG_TASK_MS = 15 * 60 * 1000

REFUSED_CLAIMS = (
    "attention or focus - nothing here measures where a student was looking",
    "engagement or effort - time in the app is not effort",
    "mastery or understanding - completing a task is not evidence of either",
    "a grade or a score - these events were never designed to be marked",
    "comparison between students - the counts depend on how each one chose to use Plip",
)

DISCLAIMERS = (
    "Counts under “measured” are what the student did in Plip, and nothing else.",
    "Everything under “inferred” is a hypothesis for you to check with the student.",
    "Screen time is not in this summary because it says nothing about learning.",
    "Only sessions the student opted in to, and chose to share, appear here.",
)


@dataclass
class TaskRecord:
    """What the log says about one task, with nothing added."""

    task_id: str
    concepts: tuple[str, ...] = ()
    hints: int = 0
    attempts: int = 0
    completed: bool = False
    outcome: str = ""
    duration_ms: int | None = None
    student_confirmed: bool = False       # the student said so, rather than Plip deciding

    def as_dict(self) -> dict[str, Any]:
        return {"taskId": self.task_id, "concepts": list(self.concepts), "hints": self.hints,
                "attempts": self.attempts, "completed": self.completed, "outcome": self.outcome,
                "durationMs": self.duration_ms, "studentConfirmed": self.student_confirmed}


@dataclass
class Observation:
    """One inference. ``basis`` is the measured counts it rests on."""

    kind: str
    statement: str
    basis: dict[str, Any] = field(default_factory=dict)
    confidence: str = "low"           # low | moderate
    concepts: tuple[str, ...] = ()

    def as_dict(self) -> dict[str, Any]:
        return {"kind": self.kind, "statement": self.statement, "basis": dict(self.basis),
                "confidence": self.confidence, "concepts": list(self.concepts)}


def tasks_from(events: Sequence[LearningEvent]) -> list[TaskRecord]:
    """Fold the event stream into one record per task, in first-seen order."""
    records: dict[str, TaskRecord] = {}
    for event in events:
        task_id = event.taskId or ""
        if not task_id:
            continue
        record = records.setdefault(task_id, TaskRecord(task_id))
        if event.conceptIds:
            record.concepts = tuple(dict.fromkeys(record.concepts + tuple(event.conceptIds)))
        evidence = event.evidence or {}
        if event.type == "hint_requested":
            record.hints = max(record.hints, int(evidence.get("hintCount") or record.hints + 1))
        elif event.type == "attempt_submitted":
            record.attempts = max(record.attempts, int(evidence.get("attempts") or record.attempts + 1))
            if evidence.get("studentConfirmed"):
                record.student_confirmed = True
        elif event.type == "task_completed":
            record.completed = True
            record.outcome = str(evidence.get("outcome") or "unknown")
            record.hints = max(record.hints, int(evidence.get("hintCount") or record.hints))
            record.attempts = max(record.attempts, int(evidence.get("attempts") or record.attempts))
            if evidence.get("durationMs") is not None:
                record.duration_ms = int(evidence["durationMs"])
            if evidence.get("studentConfirmed"):
                record.student_confirmed = True
    return list(records.values())


def _difficulties(records: Sequence[TaskRecord]) -> list[Observation]:
    out: list[Observation] = []
    for record in records:
        if record.hints >= STRUGGLE_HINTS:
            out.append(Observation(
                "difficulty",
                f"Asked for help {record.hints} times on {record.task_id}. Worth asking what was in the way.",
                {"hints": record.hints, "attempts": record.attempts, "completed": record.completed},
                "moderate" if record.hints >= STRUGGLE_HINTS + 2 else "low", record.concepts))
        elif record.attempts >= STRUGGLE_ATTEMPTS and not record.completed:
            out.append(Observation(
                "difficulty",
                f"{record.attempts} attempts on {record.task_id} with no finish recorded.",
                {"attempts": record.attempts, "completed": False}, "low", record.concepts))
        elif record.duration_ms is not None and record.duration_ms >= LONG_TASK_MS:
            out.append(Observation(
                "difficulty",
                f"{record.task_id} stayed open for {record.duration_ms // 60000} minutes. "
                "The log can't say whether that was spent on it.",
                {"durationMs": record.duration_ms}, "low", record.concepts))
    return out


def _follow_up(records: Sequence[TaskRecord], concepts: Counter) -> list[Observation]:
    out: list[Observation] = []
    hard = [record for record in records if record.hints >= STRUGGLE_HINTS
            or (record.attempts >= STRUGGLE_ATTEMPTS and not record.completed)]
    for concept in dict.fromkeys(name for record in hard for name in record.concepts):
        touched = [record for record in records if concept in record.concepts]
        finished = sum(1 for record in touched if record.completed)
        out.append(Observation(
            "follow_up",
            f"Try one more {concept} task together, or ask them to talk one through.",
            {"concept": concept, "tasksTouched": len(touched), "tasksCompleted": finished,
             "hints": sum(record.hints for record in touched)},
            "low", (concept,)))
    unfinished = [record for record in records if not record.completed]
    if unfinished and not out:
        out.append(Observation(
            "follow_up",
            f"{len(unfinished)} task(s) were started and have no finish recorded. Worth a check-in.",
            {"unfinished": len(unfinished)}, "low",
            tuple(dict.fromkeys(name for record in unfinished for name in record.concepts))))
    if not records and concepts:
        out.append(Observation("follow_up", "Sessions were shared but no task was recorded. "
                                            "Check the student knows how to start a task.", {}, "low"))
    return out


@dataclass
class Summary:
    student_id: str = ""
    class_id: str = ""
    sessions: int = 0
    measured: dict[str, Any] = field(default_factory=dict)
    tasks: list[TaskRecord] = field(default_factory=list)
    inferred: list[Observation] = field(default_factory=list)
    refused: tuple[str, ...] = REFUSED_CLAIMS
    disclaimers: tuple[str, ...] = DISCLAIMERS
    authorized: bool = True
    note: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {"studentId": self.student_id, "classId": self.class_id, "sessions": self.sessions,
                "authorized": self.authorized, "note": self.note,
                "measured": dict(self.measured),
                "tasks": [task.as_dict() for task in self.tasks],
                "inferred": [item.as_dict() for item in self.inferred],
                "refusedClaims": list(self.refused), "disclaimers": list(self.disclaimers)}

    def as_text(self) -> str:
        """The plain-text report, measured first, inference clearly labelled."""
        lines = [f"Learning summary - {self.student_id or 'unknown student'}"
                 + (f" (class {self.class_id})" if self.class_id else "")]
        if not self.authorized:
            lines.append("")
            lines.append(f"  {self.note}")
            return "\n".join(lines)
        measured = self.measured
        lines += [
            "",
            "Measured (straight from the opted-in event log)",
            f"  sessions shared        {self.sessions}",
            f"  tasks started          {measured.get('tasks_started', 0)}",
            f"  tasks completed        {measured.get('tasks_completed', 0)}"
            f" ({measured.get('tasks_confirmed_by_student', 0)} the student confirmed themselves)",
            f"  help requested         {measured.get('hints', 0)} times",
            f"  attempts submitted     {measured.get('attempts', 0)}",
        ]
        practised = measured.get("concepts") or {}
        if practised:
            lines.append("  concepts practised     "
                         + ", ".join(f"{name} x{count}" for name, count in practised.items()))
        else:
            lines.append("  concepts practised     none recorded")
        difficulties = [item for item in self.inferred if item.kind == "difficulty"]
        follow_ups = [item for item in self.inferred if item.kind == "follow_up"]
        lines += ["", "Inferred (hypotheses - please check with the student)"]
        if difficulties:
            lines += [f"  - where it looked hard: {item.statement}" for item in difficulties]
        else:
            lines.append("  - nothing stood out as difficult in these counts.")
        if follow_ups:
            lines += [f"  - suggested follow-up: {item.statement}" for item in follow_ups]
        lines += ["", "This summary does not and cannot show:"]
        lines += [f"  - {claim}" for claim in self.refused]
        lines += ["", *(f"  {line}" for line in self.disclaimers)]
        return "\n".join(lines)


def summarise(events: Sequence[LearningEvent], *, student_id: str = "", class_id: str = "") -> Summary:
    """Build a summary from events already filtered for eligibility."""
    events = list(events)
    if not events:
        return Summary(student_id=student_id, class_id=class_id, measured={"tasks_started": 0,
                                                                           "tasks_completed": 0, "hints": 0,
                                                                           "attempts": 0, "concepts": {}},
                       note="No shared events for this student in this class.")
    records = tasks_from(events)
    concepts: Counter = Counter()
    for event in events:
        for concept in event.conceptIds:
            concepts[concept] += 1
    completed = [record for record in records if record.completed]
    measured = {
        "tasks_started": sum(1 for event in events if event.type == "task_started"),
        "tasks_completed": len(completed),
        "tasks_confirmed_by_student": sum(1 for record in completed if record.student_confirmed),
        "hints": sum(1 for event in events if event.type == "hint_requested"),
        "attempts": sum(1 for event in events if event.type == "attempt_submitted"),
        "concepts": dict(concepts.most_common()),
        "outcomes": dict(Counter(record.outcome for record in completed if record.outcome)),
        "first_event": min(event.timestamp for event in events),
        "last_event": max(event.timestamp for event in events),
    }
    inferred = _difficulties(records) + _follow_up(records, concepts)
    return Summary(
        student_id=student_id or events[0].studentId,
        class_id=class_id or (events[0].classId or ""),
        sessions=len({event.sessionId for event in events}),
        measured=measured, tasks=records, inferred=inferred)


def summarise_log(log, *, allowed_classes: Sequence[str] | None = None, student_id: str = "",
                  class_id: str = "") -> Summary:
    """Filter for authorisation, then summarise. The entry point a dashboard calls."""
    classes = [str(item) for item in (allowed_classes or ()) if str(item)]
    if not classes:
        return Summary(student_id=student_id, class_id=class_id, authorized=False,
                       note="No class roster was given, so no events are eligible. A teacher summary needs the "
                            "classes you are authorised for.")
    if class_id and class_id not in classes:
        return Summary(student_id=student_id, class_id=class_id, authorized=False,
                       note=f"You are not authorised for class {class_id}.")
    eligible = log.eligible(allowed_classes=classes,
                            student_ids=[student_id] if student_id else None)
    if class_id:
        eligible = [event for event in eligible if event.classId == class_id]
    return summarise(eligible, student_id=student_id, class_id=class_id)


def class_summary(log, *, allowed_classes: Sequence[str], class_id: str) -> dict[str, Any]:
    """One summary per student in a class. Students with nothing shared don't appear."""
    classes = [str(item) for item in allowed_classes if str(item)]
    if class_id not in classes:
        return {"classId": class_id, "authorized": False,
                "note": f"You are not authorised for class {class_id}.", "students": []}
    eligible = [event for event in log.eligible(allowed_classes=classes) if event.classId == class_id]
    students = list(dict.fromkeys(event.studentId for event in eligible))
    return {"classId": class_id, "authorized": True, "students": [
        summarise([event for event in eligible if event.studentId == student], student_id=student,
                  class_id=class_id).as_dict() for student in students]}


__all__ = ["DISCLAIMERS", "LONG_TASK_MS", "REFUSED_CLAIMS", "STRUGGLE_ATTEMPTS", "STRUGGLE_HINTS",
           "Observation", "Summary", "TaskRecord", "class_summary", "summarise", "summarise_log", "tasks_from"]
