"""The teacher summary: authorised readers only, measured apart from inferred."""
from __future__ import annotations

from mcp_vision.learning.demo import CLASS_ID, STUDENTS, seed_log, synthetic_events
from mcp_vision.learning.events import build
from mcp_vision.learning.log import LearningLog
from mcp_vision.learning.summary import (
    DISCLAIMERS, REFUSED_CLAIMS, class_summary, summarise, summarise_log, tasks_from,
)


def event(kind, **options):
    base = {"session_id": "s1", "student_id": "stu_a", "class_id": "7B", "platform": "windows",
            "share_with_teacher": True}
    return build(type=kind, **{**base, **options})


def log_with(events, tmp_path) -> LearningLog:
    log = LearningLog(path=tmp_path / "events.jsonl")
    log.extend(events)
    return log


# -- authorisation ----------------------------------------------------------------
def test_no_roster_means_no_summary(tmp_path):
    log = log_with([event("task_completed", task_id="t1")], tmp_path)
    report = summarise_log(log, allowed_classes=[])
    assert not report.authorized
    assert "classes you are authorised for" in report.note
    assert report.tasks == [] and report.measured == {}


def test_a_class_you_are_not_authorised_for_is_refused(tmp_path):
    log = log_with([event("task_completed", task_id="t1")], tmp_path)
    report = summarise_log(log, allowed_classes=["8C"], class_id="7B")
    assert not report.authorized and "not authorised" in report.note


def test_an_authorised_class_comes_through(tmp_path):
    log = log_with([event("task_started", task_id="t1"), event("task_completed", task_id="t1")], tmp_path)
    report = summarise_log(log, allowed_classes=["7B"], class_id="7B")
    assert report.authorized and report.measured["tasks_completed"] == 1


def test_events_without_a_class_are_never_eligible(tmp_path):
    log = log_with([event("task_completed", task_id="t1", class_id=None)], tmp_path)
    assert log.eligible(allowed_classes=["7B"]) == []


def test_unshared_events_are_never_eligible(tmp_path):
    log = log_with([event("task_completed", task_id="t1", share_with_teacher=False)], tmp_path)
    assert log.eligible(allowed_classes=["7B"]) == []


def test_one_students_summary_does_not_include_another(tmp_path):
    log = log_with([event("task_completed", task_id="t1"),
                    event("task_completed", task_id="t2", student_id="stu_b")], tmp_path)
    report = summarise_log(log, allowed_classes=["7B"], student_id="stu_a", class_id="7B")
    assert report.measured["tasks_completed"] == 1 and report.student_id == "stu_a"


def test_the_unauthorised_report_renders_without_pretending_to_have_data(tmp_path):
    text = summarise_log(log_with([event("task_completed", task_id="t1")], tmp_path),
                         allowed_classes=[]).as_text()
    assert "authorised" in text and "Measured" not in text


# -- what is measured --------------------------------------------------------------
def test_the_counts_come_straight_off_the_log(tmp_path):
    events = [event("session_started"),
              event("task_started", task_id="t1", concept_ids=["fractions"]),
              event("hint_requested", task_id="t1", concept_ids=["fractions"], evidence={"hintCount": 1}),
              event("attempt_submitted", task_id="t1", evidence={"attempts": 1, "outcome": "incorrect"}),
              event("task_completed", task_id="t1", concept_ids=["fractions"],
                    evidence={"attempts": 2, "hintCount": 1, "outcome": "correct",
                              "studentConfirmed": True, "durationMs": 60000})]
    report = summarise_log(log_with(events, tmp_path), allowed_classes=["7B"], class_id="7B")
    measured = report.measured
    assert measured["tasks_started"] == 1
    assert measured["tasks_completed"] == 1
    assert measured["tasks_confirmed_by_student"] == 1
    assert measured["hints"] == 1
    assert measured["attempts"] == 1
    assert measured["concepts"] == {"fractions": 3}
    assert measured["outcomes"] == {"correct": 1}


def test_tasks_are_folded_one_record_each():
    records = tasks_from([event("task_started", task_id="t1"),
                          event("hint_requested", task_id="t1", evidence={"hintCount": 2}),
                          event("task_completed", task_id="t1", evidence={"outcome": "partial"})])
    assert len(records) == 1
    assert records[0].hints == 2 and records[0].completed and records[0].outcome == "partial"


def test_events_with_no_task_do_not_invent_one():
    assert tasks_from([event("session_started"), event("session_ended")]) == []


def test_a_task_started_and_never_finished_is_not_completed():
    records = tasks_from([event("task_started", task_id="t1")])
    assert records[0].completed is False and records[0].outcome == ""


def test_a_completion_plip_inferred_is_counted_separately_from_one_the_student_confirmed(tmp_path):
    events = [event("task_completed", task_id="t1", evidence={"outcome": "correct", "studentConfirmed": False}),
              event("task_completed", task_id="t2", evidence={"outcome": "correct", "studentConfirmed": True})]
    report = summarise_log(log_with(events, tmp_path), allowed_classes=["7B"], class_id="7B")
    assert report.measured["tasks_completed"] == 2
    assert report.measured["tasks_confirmed_by_student"] == 1


def test_nothing_shared_is_said_plainly(tmp_path):
    report = summarise_log(LearningLog(path=tmp_path / "e.jsonl"), allowed_classes=["7B"], class_id="7B")
    assert report.authorized and "No shared events" in report.note
    assert report.measured["tasks_completed"] == 0


# -- what is inferred, and labelled as such -----------------------------------------
def test_many_hints_become_a_difficulty_not_a_verdict():
    report = summarise([event("task_started", task_id="t1", concept_ids=["fractions"]),
                        *[event("hint_requested", task_id="t1", concept_ids=["fractions"],
                                evidence={"hintCount": n + 1}) for n in range(4)]])
    difficulties = [item for item in report.inferred if item.kind == "difficulty"]
    assert len(difficulties) == 1
    assert "Worth asking" in difficulties[0].statement
    assert difficulties[0].basis["hints"] == 4, "the inference names the counts it rests on"
    assert difficulties[0].confidence in {"low", "moderate"}


def test_repeated_attempts_with_no_finish_are_flagged():
    report = summarise([event("task_started", task_id="t1"),
                        *[event("attempt_submitted", task_id="t1", evidence={"attempts": n + 1,
                                                                             "outcome": "incorrect"})
                          for n in range(3)]])
    assert any("no finish recorded" in item.statement for item in report.inferred)


def test_a_long_task_is_reported_with_the_caveat_that_time_proves_nothing():
    report = summarise([event("task_started", task_id="t1"),
                        event("task_completed", task_id="t1", evidence={"durationMs": 20 * 60 * 1000})])
    statement = next(item.statement for item in report.inferred if item.kind == "difficulty")
    assert "can't say whether that was spent on it" in statement


def test_an_easy_run_infers_nothing_difficult():
    report = summarise([event("task_started", task_id="t1"),
                        event("task_completed", task_id="t1", evidence={"outcome": "correct", "durationMs": 1000})])
    assert [item for item in report.inferred if item.kind == "difficulty"] == []


def test_follow_up_points_at_the_concept_that_was_hard():
    report = summarise([event("task_started", task_id="t1", concept_ids=["fractions-add-unlike"]),
                        *[event("hint_requested", task_id="t1", concept_ids=["fractions-add-unlike"],
                                evidence={"hintCount": n + 1}) for n in range(3)]])
    follow = [item for item in report.inferred if item.kind == "follow_up"]
    assert follow and follow[0].concepts == ("fractions-add-unlike",)
    assert follow[0].basis["tasksTouched"] == 1


def test_unfinished_work_gets_a_check_in_suggestion():
    report = summarise([event("task_started", task_id="t1"), event("task_started", task_id="t2")])
    assert any("check-in" in item.statement for item in report.inferred)


def test_every_inference_carries_its_basis_and_confidence():
    report = summarise(synthetic_events(seed=3, days=1)[:40])
    for item in report.inferred:
        assert item.confidence in {"low", "moderate"}
        assert isinstance(item.basis, dict)


# -- the claims it refuses to make ---------------------------------------------------
def test_the_report_names_what_it_cannot_show():
    text = summarise([event("task_completed", task_id="t1")]).as_text()
    for word in ("attention", "engagement", "mastery", "grade", "comparison"):
        assert word in text, f"the report must say out loud that it cannot show {word}"


def test_no_claim_about_attention_mastery_or_grades_appears_as_a_finding():
    report = summarise(synthetic_events(seed=5, days=2))
    findings = " ".join(item.statement for item in report.inferred).lower()
    for banned in ("mastery", "mastered", "understands", "attention", "focused", "engaged", "grade", "score"):
        assert banned not in findings, f"the summary must never claim {banned!r}"


def test_screen_time_is_not_a_measured_field():
    report = summarise(synthetic_events(seed=5, days=1))
    assert "screen_time" not in report.measured and "screenTime" not in report.measured
    assert "Screen time is not in this summary" in report.as_text()


def test_the_refusals_and_disclaimers_travel_with_the_data():
    data = summarise([event("task_completed", task_id="t1")]).as_dict()
    assert data["refusedClaims"] == list(REFUSED_CLAIMS)
    assert data["disclaimers"] == list(DISCLAIMERS)


def test_the_text_keeps_the_two_halves_apart():
    text = summarise([event("task_started", task_id="t1"),
                      *[event("hint_requested", task_id="t1", evidence={"hintCount": n + 1})
                        for n in range(4)]]).as_text()
    measured_at = text.index("Measured (straight from the opted-in event log)")
    inferred_at = text.index("Inferred (hypotheses - please check with the student)")
    assert measured_at < inferred_at
    assert "Worth asking" in text[inferred_at:], "the inference must not sit under 'Measured'"


def test_the_report_is_json_safe():
    import json

    json.dumps(summarise(synthetic_events(seed=1, days=1)).as_dict())


# -- a whole class --------------------------------------------------------------------
def test_a_class_lists_only_students_who_shared(tmp_path):
    log = LearningLog(path=tmp_path / "e.jsonl")
    seed_log(log)
    report = class_summary(log, allowed_classes=[CLASS_ID], class_id=CLASS_ID)
    assert report["authorized"]
    listed = {entry["studentId"] for entry in report["students"]}
    assert STUDENTS[-1] not in listed, "the student who didn't share must not appear"
    assert listed == set(STUDENTS[:-1])


def test_a_class_you_cannot_read_returns_nothing(tmp_path):
    log = LearningLog(path=tmp_path / "e.jsonl")
    seed_log(log)
    report = class_summary(log, allowed_classes=["other"], class_id=CLASS_ID)
    assert not report["authorized"] and report["students"] == []


def test_the_demo_data_is_marked_as_invented():
    events = synthetic_events(days=1)
    assert all(event.classId == CLASS_ID for event in events)
    assert all(event.studentId.startswith("stu_demo_") for event in events)


def test_the_demo_data_obeys_the_contract():
    from mcp_vision.learning.events import parse

    for item in synthetic_events(days=1):
        assert parse(item.as_json()) is not None
