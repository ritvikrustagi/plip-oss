"""Sessions and the log: nothing recorded without a yes, retention, export, delete."""
from __future__ import annotations

from mcp_vision.learning.consent import SessionConsent
from mcp_vision.learning.log import LearningLog, event_age_days
from mcp_vision.learning.session import LearningSession, pseudonym


def session(tmp_path, **options) -> LearningSession:
    log = LearningLog(path=tmp_path / "events.jsonl")
    consent = SessionConsent()
    recorder = LearningSession(log=log, consent=consent, student_id="stu_test", platform="windows")
    if options.pop("started", True):
        recorder.start(**options)     # writes session_started, like the shell does
    return recorder


# -- the opt-in gate ----------------------------------------------------------------
def test_nothing_is_written_before_a_session_starts(tmp_path):
    recorder = session(tmp_path, started=False)
    assert recorder.task_started("t1") is None
    assert recorder.hint_requested("t1") is None
    assert recorder.task_completed("t1") is None
    assert recorder.log.events() == []


def test_a_paused_session_writes_nothing(tmp_path):
    recorder = session(tmp_path)
    recorder.task_started("t1")
    recorder.pause()
    assert recorder.hint_requested("t1") is None
    assert [event.type for event in recorder.log.events()] == ["session_started", "task_started"]


def test_resuming_starts_recording_again(tmp_path):
    recorder = session(tmp_path)
    recorder.pause()
    recorder.resume()
    assert recorder.task_started("t1") is not None


def test_stopping_writes_the_closing_event_then_shuts_the_gate(tmp_path):
    recorder = session(tmp_path)
    recorder.task_started("t1")
    recorder.stop()
    assert [event.type for event in recorder.log.events()][-1] == "session_ended"
    assert recorder.task_started("t2") is None


def test_start_writes_a_session_started_event(tmp_path):
    recorder = session(tmp_path, started=False)
    recorder.start(granted_by="student", class_id="7B")
    assert [event.type for event in recorder.log.events()] == ["session_started"]
    assert recorder.log.events()[0].classId == "7B"


# -- sharing ------------------------------------------------------------------------
def test_share_with_teacher_is_the_switch_at_the_time_of_the_event(tmp_path):
    recorder = session(tmp_path, class_id="7B", share_with_teacher=False)
    recorder.task_started("t1")
    recorder.set("share_with_teacher", True)
    recorder.task_completed("t1")
    shared = {event.type: event.shareWithTeacher for event in recorder.log.events()}
    assert shared["task_started"] is False and shared["task_completed"] is True, \
        "turning sharing on must not retroactively share what came before"


def test_an_unshared_session_is_invisible_to_a_teacher(tmp_path):
    recorder = session(tmp_path, class_id="7B", share_with_teacher=False)
    recorder.task_started("t1")
    assert recorder.log.eligible(allowed_classes=["7B"]) == []


# -- counting ----------------------------------------------------------------------
def test_hints_and_attempts_are_counted_per_task(tmp_path):
    recorder = session(tmp_path)
    recorder.task_started("t1", concept_ids=["fractions"])
    recorder.hint_requested("t1")
    recorder.hint_requested("t1")
    recorder.attempt_submitted("t1", outcome="incorrect")
    done = recorder.task_completed("t1", outcome="correct", student_confirmed=True)
    assert done.evidence["hintCount"] == 2 and done.evidence["attempts"] == 1
    assert done.evidence["studentConfirmed"] is True


def test_the_task_concepts_carry_through_without_repeating_them(tmp_path):
    recorder = session(tmp_path)
    recorder.task_started("t1", concept_ids=["fractions-equivalent"])
    assert recorder.hint_requested("t1").conceptIds == ("fractions-equivalent",)


def test_a_task_id_is_generated_when_none_is_given(tmp_path):
    recorder = session(tmp_path)
    event = recorder.task_started()
    assert event.taskId and event.taskId.startswith("task_")


def test_duration_is_measured_not_guessed(tmp_path):
    recorder = session(tmp_path)
    ticks = iter([0.0, 2.5])
    recorder.clock = lambda: next(ticks)
    recorder.task_started("t1")
    assert recorder.task_completed("t1").evidence["durationMs"] == 2500


def test_a_completed_task_stops_being_tracked(tmp_path):
    recorder = session(tmp_path)
    recorder.task_started("t1")
    recorder.task_completed("t1")
    assert recorder._tasks == {}


def test_two_open_tasks_are_not_confused_by_a_blank_id(tmp_path):
    recorder = session(tmp_path)
    recorder.task_started("t1")
    recorder.task_started("t2")
    recorder.hint_requested("")             # ambiguous: don't attribute it to either
    assert recorder._tasks["t1"]["hints"] == 0 and recorder._tasks["t2"]["hints"] == 0


# -- the pseudonym ------------------------------------------------------------------
def test_the_student_id_is_stable_but_says_nothing_about_the_person(tmp_path):
    path = tmp_path / "id"
    first = pseudonym(path)
    assert first == pseudonym(path), "stable across restarts"
    assert first.startswith("stu_") and len(first) == 20
    import getpass
    import socket

    for personal in (getpass.getuser(), socket.gethostname()):
        assert personal.lower() not in first.lower()


def test_two_machines_get_different_ids(tmp_path):
    assert pseudonym(tmp_path / "a") != pseudonym(tmp_path / "b")


# -- the log ------------------------------------------------------------------------
def test_events_land_as_one_json_line_each(tmp_path):
    recorder = session(tmp_path)
    recorder.task_started("t1")
    recorder.task_completed("t1")
    lines = recorder.log.path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 3      # session_started + the two
    assert all(line.startswith("{") and line.endswith("}") for line in lines)


def test_retention_drops_old_events(tmp_path):
    log = LearningLog(path=tmp_path / "events.jsonl", max_age_days=7)
    from mcp_vision.learning.events import build

    old = build(session_id="s", student_id="stu", type="task_started",
                clock=lambda: __import__("datetime").datetime(2020, 1, 1,
                                                              tzinfo=__import__("datetime").timezone.utc))
    log.append(old)
    assert log.events() == [], "an event past the window is gone on the next write"


def test_recent_events_are_kept(tmp_path):
    recorder = session(tmp_path)
    recorder.task_started("t1")
    assert len(recorder.log.events()) == 2


def test_retention_can_be_switched_off_for_a_school_that_needs_it(tmp_path):
    log = LearningLog(path=tmp_path / "e.jsonl", max_age_days=0)
    assert log.trim() == 0


def test_an_unreadable_timestamp_is_kept_rather_than_silently_dropped():
    from mcp_vision.learning.events import LearningEvent

    assert event_age_days(LearningEvent("s", "stu", "task_started", "not a date")) == 0.0


def test_a_broken_line_is_skipped_not_fatal(tmp_path):
    path = tmp_path / "events.jsonl"
    path.write_text('{"nope"\n', encoding="utf-8")
    assert LearningLog(path=path).events() == []


def test_a_missing_log_reads_as_empty(tmp_path):
    assert LearningLog(path=tmp_path / "gone.jsonl").events() == []


# -- export and delete ---------------------------------------------------------------
def test_export_is_the_students_own_copy(tmp_path):
    recorder = session(tmp_path)
    recorder.task_started("t1")
    text = recorder.export()
    assert len(text.splitlines()) == 2
    import json

    assert json.loads(text.splitlines()[0])["type"] == "session_started"


def test_export_as_one_json_array(tmp_path):
    import json

    recorder = session(tmp_path)
    recorder.task_started("t1")
    assert len(json.loads(recorder.log.export_json())) == 2


def test_delete_everything_removes_the_file(tmp_path):
    recorder = session(tmp_path)
    recorder.task_started("t1")
    assert recorder.log.delete_all() == 2
    assert not recorder.log.path.exists() and recorder.log.events() == []


def test_one_session_can_be_deleted_on_its_own(tmp_path):
    recorder = session(tmp_path)
    recorder.task_started("t1")
    first = recorder.consent.session_id
    recorder.stop()
    recorder.start()
    recorder.task_started("t2")
    assert recorder.log.delete_session(first) == 3
    assert {event.sessionId for event in recorder.log.events()} == {recorder.consent.session_id}


def test_forget_everything_also_drops_the_consent_record_and_the_id(tmp_path, monkeypatch):
    monkeypatch.setenv("MCP_VISION_STATE_DIR", str(tmp_path / "state"))
    recorder = LearningSession(log=LearningLog(path=tmp_path / "e.jsonl"))
    recorder.start(screenshots=True)
    recorder.task_started("t1")
    assert recorder.forget_everything() == 2
    assert recorder.consent.stopped and not recorder.consent.screenshots
    assert not (tmp_path / "state" / "learning-id").exists()


# -- paths handed in as strings ------------------------------------------------------
def test_a_log_path_given_as_a_string_works(tmp_path):
    log = LearningLog(path=str(tmp_path / "events.jsonl"))
    from mcp_vision.learning.events import build

    log.append(build(session_id="s", student_id="stu", type="session_started"))
    assert len(log.events()) == 1


def test_a_consent_path_given_as_a_string_works(tmp_path):
    target = str(tmp_path / "consent.json")
    SessionConsent().start(screenshots=True).save(target)
    assert SessionConsent.load(target).allows("screenshots")
    assert SessionConsent.revoke_all(target).stopped


def test_a_pseudonym_path_given_as_a_string_works(tmp_path):
    assert pseudonym(str(tmp_path / "id")) == pseudonym(tmp_path / "id")
