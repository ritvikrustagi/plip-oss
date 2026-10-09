"""Consent: off by default, visible, pausable, and deletable."""
from __future__ import annotations

import pytest

from mcp_vision.learning.consent import SessionConsent


def file(tmp_path):
    return tmp_path / "consent.json"


# -- defaults ---------------------------------------------------------------------
def test_nothing_is_on_before_anyone_says_yes():
    consent = SessionConsent()
    assert consent.stopped and not consent.active
    for switch in ("screenshots", "screen_context", "share_with_teacher"):
        assert not getattr(consent, switch)
        assert not consent.allows(switch)


def test_with_no_session_even_plain_events_are_refused():
    assert not SessionConsent().allows("events")


def test_starting_a_session_still_leaves_the_switches_off():
    consent = SessionConsent().start()
    assert consent.active and consent.allows("events")
    assert not consent.allows("screenshots") and not consent.allows("screen_context")


def test_a_session_gets_an_id_and_a_start_time():
    consent = SessionConsent().start(clock=lambda: 1000.0)
    assert consent.session_id and consent.started_at == 1000.0


def test_each_session_is_a_new_id():
    consent = SessionConsent()
    first = consent.start().session_id
    assert consent.start().session_id != first


# -- who may grant ----------------------------------------------------------------
@pytest.mark.parametrize("who", ["student", "teacher", "guardian", "demo"])
def test_the_recognised_granters(who):
    assert SessionConsent().start(granted_by=who).granted_by == who


def test_an_unrecognised_granter_is_refused():
    with pytest.raises(ValueError, match="can't grant consent"):
        SessionConsent().start(granted_by="the_app")


def test_what_they_were_told_is_recorded():
    consent = SessionConsent().start(note="Plip will see your screen while this session runs.")
    assert "see your screen" in consent.note


# -- pause and stop ---------------------------------------------------------------
def test_pausing_stops_everything_without_ending_the_session():
    consent = SessionConsent().start(screenshots=True, screen_context=True, share_with_teacher=True)
    consent.pause()
    assert consent.session_id and not consent.active
    for switch in ("events", "screenshots", "screen_context", "share_with_teacher"):
        assert not consent.allows(switch)
    assert "paused" in consent.why_not("screenshots")


def test_resuming_brings_the_switches_back_as_they_were():
    consent = SessionConsent().start(screenshots=True)
    consent.pause()
    consent.resume()
    assert consent.allows("screenshots")


def test_stopping_clears_the_switches_so_a_stale_reference_cannot_resume():
    consent = SessionConsent().start(screenshots=True, share_with_teacher=True)
    consent.stop()
    consent.resume()
    assert not consent.active and not consent.screenshots and not consent.share_with_teacher


def test_switching_something_on_without_a_session_is_an_error():
    with pytest.raises(ValueError, match="No session"):
        SessionConsent().set("screenshots", True)


def test_only_the_three_real_switches_can_be_set():
    with pytest.raises(ValueError, match="isn't a session switch"):
        SessionConsent().start().set("stopped", True)


# -- what the UI shows ------------------------------------------------------------
def test_every_switch_row_carries_its_own_explanation():
    rows = SessionConsent().as_rows()
    assert [row["id"] for row in rows] == ["screen_context", "screenshots", "share_with_teacher"]
    for row in rows:
        assert row["detail"] and not row["on"] and not row["available"]


def test_the_screenshot_row_promises_nothing_is_uploaded():
    row = next(item for item in SessionConsent().as_rows() if item["id"] == "screenshots")
    assert "Nothing is uploaded" in row["detail"]


def test_the_sharing_row_says_what_a_teacher_sees():
    row = next(item for item in SessionConsent().as_rows() if item["id"] == "share_with_teacher")
    assert "No text, no screens" in row["detail"]


def test_why_not_tells_you_what_to_do_about_it():
    assert "Start one" in SessionConsent().why_not("screenshots")
    consent = SessionConsent().start()
    assert "off for this session" in consent.why_not("screenshots")
    consent.set("screenshots", True)
    assert consent.why_not("screenshots") == ""


def test_the_summary_names_what_is_on():
    assert SessionConsent().summary() == "No session running."
    consent = SessionConsent().start(screenshots=True)
    assert "running" in consent.summary() and "screenshots" in consent.summary()
    consent.pause()
    assert "paused" in consent.summary()


# -- disk -------------------------------------------------------------------------
def test_it_survives_a_restart(tmp_path):
    SessionConsent().start(class_id="7B", screenshots=True).save(file(tmp_path))
    back = SessionConsent.load(file(tmp_path))
    assert back.class_id == "7B" and back.allows("screenshots")


def test_a_missing_or_broken_file_means_no_consent(tmp_path):
    assert SessionConsent.load(tmp_path / "nope.json").stopped
    broken = file(tmp_path)
    broken.write_text("{{{")
    assert SessionConsent.load(broken).stopped


def test_unknown_keys_in_the_file_are_ignored(tmp_path):
    import json

    file(tmp_path).write_text(json.dumps({"session_id": "s", "stopped": False, "mystery": 1}))
    assert SessionConsent.load(file(tmp_path)).session_id == "s"


def test_revoking_deletes_the_record(tmp_path):
    path = file(tmp_path)
    SessionConsent().start(screenshots=True).save(path)
    assert SessionConsent.revoke_all(path).stopped
    assert not path.exists()


def test_revoking_when_there_is_nothing_to_revoke_is_fine(tmp_path):
    assert SessionConsent.revoke_all(tmp_path / "nope.json").stopped


def test_a_class_code_is_trimmed_and_bounded():
    assert SessionConsent().start(class_id="  7  B  ").class_id == "7 B"
    assert len(SessionConsent().start(class_id="x" * 200).class_id) == 64
