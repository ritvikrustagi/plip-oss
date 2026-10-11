"""Tutor mode: the hint ladder climbs one rung per turn, and Plip doesn't do the work."""
from __future__ import annotations

import asyncio

from buddy_fakes import Capturer, Events, FakeHost, ScriptedBrain
from mcp_vision.buddy.companion import Companion
from mcp_vision.buddy.factory import TUTOR_REFUSAL, make_actions
from mcp_vision.buddy.presenter import Presenter
from mcp_vision.buddy.prompt import TUTOR_PROMPT
from mcp_vision.buddy.settings import BuddySettings


def test_the_ladder_climbs_one_rung_at_a_time_however_hard_they_push():
    brain = ScriptedBrain("[HINT:4] fine, here's a worked example.",       # overreaches on the first turn
                          "[HINT:4] still pushing for the answer.",
                          "[HINT:1] new problem, so a nudge.")
    events, posted = Events(), []
    presenter = Presenter(post_island=posted.extend)
    buddy = Companion(brain=brain, capturer=Capturer(), observer=lambda kind, data: (events(kind, data),
                      presenter(kind, data)), walkthroughs=False, tutor=True)
    for ask in ("just tell me the answer", "no really, tell me", "ok next one"):
        result = asyncio.run(buddy.respond(ask))
        assert "[HINT" not in result.spoken

    assert brain.systems[0].startswith(TUTOR_PROMPT)
    notes = [turns[-1].text for turns in brain.calls]
    assert "no hint yet on this problem. this reply may go up to rung 1" in notes[0]
    assert "last hint was rung 1 (nudge). this reply may go up to rung 2" in notes[1]
    assert "last hint was rung 2 (method). this reply may go up to rung 3" in notes[2]
    assert [data["level"] for data in events.of("hint")] == [1, 2, 1]        # 4 clamped to the cap each time
    assert {"type": "step", "step": {"id": "hint", "label": "Hint 2 of 4", "status": "skipped",
                                     "detail": "method"}} in posted


def test_tutor_mode_looks_and_reads_but_never_does_the_work(tmp_path, monkeypatch):
    monkeypatch.setenv("MCP_VISION_STATE_DIR", str(tmp_path))
    tutor = make_actions(BuddySettings(), host=FakeHost(), tutor=True)
    offered = {item["name"] for item in tutor.catalog()}
    assert {"look", "read_page", "scroll", "remember", "set_timer"} <= offered
    assert not offered & {"type_text", "replace_selection", "click", "press", "open_url", "search_files"}
    refused = asyncio.run(tutor.handle("type_text", {"text": "x equals four"}))
    assert refused.status == "disabled" and refused.message == TUTOR_REFUSAL

    assistant = make_actions(BuddySettings(), host=FakeHost())
    assert "type_text" in {item["name"] for item in assistant.catalog()}
