"""Synthetic sessions, so the dashboard and the summary can be seen working.

Everything here is made up: the student ids are the pseudonym format with a
``demo`` marker, the class is ``demo-class``, the tasks are fractions and
sentence openers. No real student, roster or record is involved, and
``granted_by="demo"`` marks every consent record so demo data can never be
mistaken for a real opt-in.
"""
from __future__ import annotations

import random
from datetime import datetime, timedelta, timezone

from mcp_vision.learning.events import build
from mcp_vision.learning.log import LearningLog

CLASS_ID = "demo-class"
CONCEPTS = {
    "fractions-equivalent": ("task-frac-1", "task-frac-2"),
    "fractions-add-unlike": ("task-frac-3",),
    "sentence-openers": ("task-write-1",),
    "paragraph-structure": ("task-write-2",),
}
STUDENTS = ("stu_demo_aurora", "stu_demo_basil", "stu_demo_clove")


def synthetic_events(*, seed: int = 7, days: int = 3, share: bool = True, platform: str = "windows") -> list:
    """A few days of plausible, entirely invented sessions."""
    rng = random.Random(seed)
    start = datetime.now(timezone.utc) - timedelta(days=days)
    out = []
    for day in range(days):
        for index, student in enumerate(STUDENTS):
            session_id = f"demo-{seed}-{day}-{index}"
            moment = start + timedelta(days=day, hours=9 + index)

            def clock(moment=moment):
                return moment

            shared = share and student != STUDENTS[-1]        # one student keeps theirs private
            out.append(build(session_id=session_id, student_id=student, type="session_started",
                             platform=platform, class_id=CLASS_ID, share_with_teacher=shared, clock=clock))
            for concept, tasks in CONCEPTS.items():
                task_id = rng.choice(tasks)
                hints = rng.choice([0, 0, 1, 2, 4])
                attempts = rng.choice([1, 1, 2, 3])
                out.append(build(session_id=session_id, student_id=student, type="task_started",
                                 platform=platform, class_id=CLASS_ID, task_id=task_id,
                                 concept_ids=[concept], share_with_teacher=shared, clock=clock))
                for hint in range(hints):
                    out.append(build(session_id=session_id, student_id=student, type="hint_requested",
                                     platform=platform, class_id=CLASS_ID, task_id=task_id,
                                     concept_ids=[concept], evidence={"hintCount": hint + 1},
                                     share_with_teacher=shared, clock=clock))
                for attempt in range(attempts):
                    out.append(build(session_id=session_id, student_id=student, type="attempt_submitted",
                                     platform=platform, class_id=CLASS_ID, task_id=task_id,
                                     concept_ids=[concept],
                                     evidence={"attempts": attempt + 1,
                                               "outcome": "incorrect" if attempt + 1 < attempts else "correct",
                                               "studentConfirmed": True},
                                     share_with_teacher=shared, clock=clock))
                if hints < 4:
                    out.append(build(session_id=session_id, student_id=student, type="task_completed",
                                     platform=platform, class_id=CLASS_ID, task_id=task_id,
                                     concept_ids=[concept],
                                     evidence={"attempts": attempts, "hintCount": hints, "outcome": "correct",
                                               "durationMs": rng.randint(90, 900) * 1000,
                                               "studentConfirmed": True},
                                     share_with_teacher=shared, clock=clock))
            out.append(build(session_id=session_id, student_id=student, type="session_ended",
                             platform=platform, class_id=CLASS_ID, share_with_teacher=shared, clock=clock))
    return out


def seed_log(log: LearningLog | None = None, **options) -> int:
    """Write the synthetic events into a log. Returns how many landed."""
    log = log or LearningLog()
    return log.extend(synthetic_events(**options))


__all__ = ["CLASS_ID", "CONCEPTS", "STUDENTS", "seed_log", "synthetic_events"]
