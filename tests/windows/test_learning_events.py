"""Learning-event contract v1: the shape, and the fields it must refuse."""
from __future__ import annotations

import json

import pytest

from mcp_vision.learning.events import (
    EVENT_TYPES, EVIDENCE_FIELDS, FIELDS, PLATFORMS, SCHEMA_VERSION, ContractError, build,
    check_payload, clean_evidence, contract_summary, parse,
)


def event(**options):
    base = {"session_id": "s1", "student_id": "stu_abc", "type": "task_completed"}
    return build(**{**base, **options})


# -- the shape ---------------------------------------------------------------------
def test_the_contract_is_v1_with_the_agreed_fields():
    assert SCHEMA_VERSION == 1
    assert FIELDS == ("eventId", "schemaVersion", "sessionId", "studentId", "classId", "timestamp",
                      "platform", "type", "taskId", "conceptIds", "evidence", "shareWithTeacher")
    assert EVENT_TYPES == ("session_started", "task_started", "hint_requested", "attempt_submitted",
                           "task_completed", "session_ended")
    assert PLATFORMS == ("windows", "chromebook", "extension")
    assert EVIDENCE_FIELDS == ("attempts", "hintCount", "outcome", "durationMs", "studentConfirmed")


def test_a_minimal_event_has_every_required_field():
    data = event().as_dict()
    for key in ("eventId", "schemaVersion", "sessionId", "studentId", "timestamp", "platform",
                "type", "conceptIds", "shareWithTeacher"):
        assert key in data, key
    assert data["schemaVersion"] == 1 and data["platform"] == "windows"


def test_optional_fields_are_left_out_rather_than_nulled():
    data = event().as_dict()
    assert "classId" not in data and "taskId" not in data and "evidence" not in data


def test_event_ids_are_unique_so_a_replayed_export_cannot_double_count():
    assert event().eventId != event().eventId


def test_the_timestamp_carries_an_offset():
    stamp = event().timestamp
    assert stamp.endswith("+00:00") or stamp[-6] in "+-"


def test_json_round_trips():
    original = event(class_id="7B", task_id="t1", concept_ids=["fractions"],
                     evidence={"attempts": 2, "outcome": "correct"}, share_with_teacher=True)
    back = parse(original.as_json())
    assert back.as_dict() == original.as_dict()


def test_key_order_follows_the_contract():
    data = json.loads(event(class_id="7B", task_id="t1").as_json())
    assert [key for key in data] == [key for key in FIELDS if key in data]


# -- validation ---------------------------------------------------------------------
def test_an_unknown_type_is_refused_by_name():
    with pytest.raises(ContractError, match="screenshot_taken"):
        event(type="screenshot_taken")


def test_an_unknown_platform_is_refused():
    with pytest.raises(ContractError, match="android"):
        event(platform="android")


def test_an_event_needs_a_session_and_a_student():
    with pytest.raises(ContractError, match="pseudonymous"):
        build(session_id="", student_id="stu", type="session_started")


def test_concepts_are_deduplicated_and_capped():
    many = event(concept_ids=["a", "a", "b", *[f"c{index}" for index in range(30)]])
    assert many.conceptIds[:3] == ("a", "b", "c0")
    assert len(many.conceptIds) <= 12


def test_blank_concepts_are_dropped():
    assert event(concept_ids=["", "  ", "real"]).conceptIds == ("real",)


# -- evidence -----------------------------------------------------------------------
def test_only_the_five_measured_fields_survive():
    kept = clean_evidence({"attempts": 2, "hintCount": 1, "outcome": "correct", "durationMs": 500,
                           "studentConfirmed": True, "mood": "frustrated", "score": 82})
    assert set(kept) == set(EVIDENCE_FIELDS), "a 'mood' or a 'score' is not measured evidence"


def test_counts_are_coerced_and_never_negative():
    kept = clean_evidence({"attempts": "3", "hintCount": -5, "durationMs": -1})
    assert kept == {"attempts": 3, "hintCount": 0, "durationMs": 0}


def test_an_unknown_outcome_becomes_unknown():
    assert clean_evidence({"outcome": "brilliant"})["outcome"] == "unknown"
    assert clean_evidence({"outcome": "partial"})["outcome"] == "partial"


def test_empty_evidence_is_dropped_entirely():
    assert clean_evidence({}) is None
    assert clean_evidence({"attempts": None}) is None


def test_student_confirmed_is_preserved_because_the_summary_depends_on_it():
    assert clean_evidence({"studentConfirmed": True})["studentConfirmed"] is True


# -- what an event may never carry ---------------------------------------------------
@pytest.mark.parametrize("payload, word", [
    ({"screenshot": "iVBOR..."}, "pixels"),
    ({"url": "https://example.com/quiz"}, "browsing"),
    ({"windowTitle": "Algebra homework - Chrome"}, "titles"),
    ({"transcript": "how do I do question 4"}, "what the student said"),
    ({"promptText": "You are a tutor..."}, "free text"),
    ({"answerText": "The answer is 7"}, "free text"),
    ({"keystrokes": "abc"}, "typing"),
    ({"studentName": "Sam"}, "name"),
    ({"email": "sam@school.org"}, "contact"),
    ({"clipboard": "..."}, "clipboard"),
    ({"selection": "x + 2 = 5"}, "selected"),
])
def test_surveillance_fields_are_refused_with_the_reason(payload, word):
    with pytest.raises(ContractError) as caught:
        check_payload(payload)
    assert word in str(caught.value)


def test_a_nested_forbidden_field_is_caught():
    with pytest.raises(ContractError, match="pixels"):
        check_payload({"evidence": {"extra": {"screenshot": "..."}}})


def test_a_forbidden_field_inside_a_list_is_caught():
    with pytest.raises(ContractError, match="browsing"):
        check_payload({"items": [{"ok": 1}, {"url": "http://x"}]})


def test_the_id_fields_are_not_mistaken_for_names():
    check_payload({"eventId": "1", "sessionId": "2", "studentId": "3", "classId": "4", "taskId": "5"})


def test_evidence_with_a_forbidden_key_fails_the_build():
    with pytest.raises(ContractError, match="pixels"):
        event(evidence={"screenshot": "abc"})


# -- reading events back -------------------------------------------------------------
def test_a_future_schema_version_is_not_guessed_at():
    assert parse(json.dumps({"schemaVersion": 2, "type": "task_started"})) is None


def test_junk_lines_are_skipped():
    assert parse("not json") is None
    assert parse("[]") is None
    assert parse(json.dumps({"schemaVersion": 1, "type": "mystery"})) is None


def test_an_event_carrying_a_forbidden_extra_field_is_rejected_on_read():
    smuggled = json.loads(event().as_json())
    smuggled["url"] = "https://example.com"
    assert parse(json.dumps(smuggled)) is None, "a tampered log line is dropped, not trusted"


def test_an_unknown_but_harmless_extra_field_is_tolerated():
    extra = json.loads(event().as_json())
    extra["recordedBy"] = "plip-windows-0.10"
    assert parse(json.dumps(extra)) is not None


def test_contract_summary_names_what_this_build_believes():
    summary = contract_summary()
    assert summary["schemaVersion"] == 1
    assert "screenshot" in summary["forbidden"] and "transcript" in summary["forbidden"]
    assert summary["platforms"] == list(PLATFORMS)
