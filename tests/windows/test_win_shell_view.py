"""``ShellView``: the window's state, folded from the same messages macOS uses."""
from __future__ import annotations

from mcp_vision.buddy.presenter import Presenter
from mcp_vision.buddy.shell_view import ShellView
from mcp_vision.learning.consent import SessionConsent
from mcp_vision.platforms import capabilities


def view(**options) -> ShellView:
    return ShellView(**options)


def wired() -> tuple[Presenter, ShellView]:
    """A real presenter posting into a real view - the Windows wiring, minus Tk."""
    shell = view(capabilities=capabilities("win32"), consent=SessionConsent())
    return Presenter(post_island=shell.post), shell


# -- message folding --------------------------------------------------------------
def test_island_state_merges_rather_than_replaces():
    shell = view()
    shell.post([{"type": "island", "state": {"phase": "thinking", "transcript": "hello"}}])
    shell.post([{"type": "island", "state": {"phase": "answering"}}])
    assert shell.island["phase"] == "answering"
    assert shell.island["transcript"] == "hello", "an update of one field keeps the others"


def test_append_builds_the_answer_as_it_streams():
    shell = view()
    for chunk in ("Half ", "of ", "six is three."):
        shell.post([{"type": "append", "field": "answer", "text": chunk}])
    assert shell.render()["answer"] == "Half of six is three."


def test_reset_clears_the_turn():
    shell = view()
    shell.post([{"type": "island", "state": {"answer": "old"}}, {"type": "step", "step": {"id": "a", "label": "A"}}])
    shell.post([{"type": "reset"}])
    assert shell.render()["answer"] == "" and shell.checklist() == []


def test_steps_are_updated_in_place_not_appended_twice():
    shell = view()
    shell.post([{"type": "step", "step": {"id": "look", "label": "Looking", "status": "active"}}])
    shell.post([{"type": "step", "step": {"id": "look", "status": "done", "detail": "120ms"}}])
    assert shell.checklist() == ["✓ Looking  (120ms)"]


def test_a_step_with_no_id_is_ignored():
    shell = view()
    shell.post([{"type": "step", "step": {"label": "nameless"}}])
    assert shell.checklist() == []


def test_on_change_fires_once_per_batch():
    calls = []
    shell = view(on_change=lambda: calls.append(1))
    shell.post([{"type": "island", "state": {"phase": "thinking"}},
                {"type": "step", "step": {"id": "a", "label": "A"}}])
    assert len(calls) == 1


def test_a_failing_redraw_does_not_break_the_turn():
    shell = view(on_change=lambda: (_ for _ in ()).throw(RuntimeError("tk is gone")))
    shell.post([{"type": "island", "state": {"phase": "thinking"}}])      # must not raise


# -- the walkthrough checklist ----------------------------------------------------
def test_the_plan_shows_progress():
    shell = view()
    shell.post([{"type": "island", "state": {"plan": ["Open Word", "Click Insert", "Pick Table"],
                                             "planIndex": 1}}])
    assert shell.checklist() == ["✓ Open Word", "… Click Insert", "○ Pick Table"]


def test_a_walkthrough_shows_its_position_in_the_status():
    presenter, shell = wired()
    presenter("walkthrough", {"index": 1, "total": 4, "label": "Click Insert"})
    assert "step 2 of 4" in shell.status_line()


def test_your_turn_lands_as_a_checklist_row():
    presenter, shell = wired()
    presenter("walkthrough", {"index": 0, "total": 2, "label": "Try it", "waiting": True})
    assert any("Your turn" in line for line in shell.checklist())


def test_finishing_a_walkthrough_ticks_it():
    presenter, shell = wired()
    presenter("walkthrough", {"index": 1, "total": 2, "finished": True})
    assert any(line.startswith("✓ All done") for line in shell.checklist())


# -- the safety card --------------------------------------------------------------
def test_a_consequential_action_shows_a_card_with_both_answers():
    presenter, shell = wired()
    presenter("confirm", {"title": "Send to Mrs Patel", "lines": ["To: Mrs Patel", "Subject: homework"],
                          "confirm": "Send it", "name": "send_message"})
    card = shell.confirm_card()
    assert card["title"] == "Send to Mrs Patel" and card["confirm"] == "Send it"
    assert "[Send it]  [No]" in "\n".join(shell.lines())


def test_a_cleared_card_disappears():
    presenter, shell = wired()
    presenter("confirm", {"title": "Delete the folder"})
    presenter("confirm", {"cleared": True})
    assert shell.confirm_card() is None


def test_a_card_with_no_title_still_asks():
    shell = view()
    shell.post([{"type": "island", "state": {"confirm": {}}}])
    assert shell.confirm_card()["title"] == "Do this?"


def test_card_lines_are_capped():
    shell = view()
    shell.post([{"type": "island", "state": {"confirm": {"lines": [str(n) for n in range(20)]}}}])
    assert len(shell.confirm_card()["lines"]) == 6


# -- the status line --------------------------------------------------------------
def test_an_error_takes_over_the_status():
    presenter, shell = wired()
    presenter.failed("I couldn't hear you.")
    assert shell.status_line().startswith("Problem: I couldn't hear you")


def test_the_brain_is_named_in_the_status():
    presenter, shell = wired()
    presenter("engine", {"label": "Claude Code", "kind": "subscription"})
    assert "Claude Code" in shell.status_line()


def test_a_finished_turn_shows_how_long_it_took():
    presenter, shell = wired()
    presenter("done", {"latency_ms": 2400})
    assert "2.4s" in shell.status_line()


# -- greyed-out controls, with reasons -------------------------------------------
def test_windows_controls_name_what_is_off_and_why():
    shell = view(capabilities=capabilities("win32"), consent=SessionConsent())
    off = {row["id"]: row for row in shell.controls() if not row["enabled"]}
    assert "talk_engine" in off and "AssemblyAI" in off["talk_engine"]["reason"]
    assert off["shortcuts"]["label"] == "Run an Apple Shortcut"
    assert "AppleScript" in off["applescript"]["reason"]
    assert "macOS-only" in off["point"]["reason"]
    assert all(row["reason"] for row in off.values()), "a disabled control without a reason is a dead end"


def test_typing_is_always_available_on_windows():
    shell = view(capabilities=capabilities("win32"), consent=SessionConsent())
    ask = next(row for row in shell.controls() if row["id"] == "ask")
    assert ask["enabled"] and ask["reason"] == ""


def test_screenshots_are_off_until_a_session_says_yes():
    consent = SessionConsent()
    shell = view(capabilities=capabilities("win32"), consent=consent)
    shot = next(row for row in shell.controls() if row["id"] == "screenshot")
    assert not shot["enabled"] and "No learning session" in shot["reason"]
    consent.start(screenshots=True)
    shot = next(row for row in shell.controls() if row["id"] == "screenshot")
    assert shot["enabled"]


def test_pausing_turns_the_switches_off_without_ending_the_session():
    consent = SessionConsent().start(screenshots=True, screen_context=True)
    shell = view(capabilities=capabilities("win32"), consent=consent)
    consent.pause()
    off = {row["id"]: row["reason"] for row in shell.controls() if not row["enabled"]}
    assert "paused" in off["screenshot"] and "paused" in off["map"]


def test_a_capability_the_machine_lacks_beats_the_session_switch():
    # On macOS the session can allow screenshots; where the OS can't, the OS wins.
    shell = view(capabilities=capabilities("linux"), consent=SessionConsent().start(screen_context=True))
    row = next(item for item in shell.controls() if item["id"] == "map")
    assert not row["enabled"] and "plip ask --image" in row["reason"]


def test_with_no_tables_nothing_is_claimed_disabled():
    assert all(row["enabled"] for row in view().controls())


# -- the text rendering -----------------------------------------------------------
def test_lines_cover_a_whole_turn():
    presenter, shell = wired()
    shell.post([{"type": "shortcut", "state": {"id": "control+option", "keys": ["Ctrl", "Alt"],
                                               "label": "Ctrl + Alt", "works": True}}])
    presenter.listening()
    presenter.transcript("how do I add a table")
    presenter.thinking()
    presenter("step", {"id": "look", "label": "Looked at 1 screen", "status": "done"})
    presenter("answer", {"text": "Insert, then Table."})
    presenter("done", {"latency_ms": 1800})
    text = "\n".join(shell.lines())
    assert "hold Ctrl + Alt to talk" in text
    assert "you: how do I add a table" in text
    assert "plip: Insert, then Table." in text
    assert "✓ Looked at 1 screen" in text


def test_a_shortcut_that_is_not_being_heard_says_so():
    shell = view()
    shell.post([{"type": "shortcut", "state": {"label": "Ctrl + Alt", "works": False}}])
    assert "(not listening)" in "\n".join(shell.lines())


def test_an_offer_shows_both_answers():
    presenter, shell = wired()
    presenter("offer", {"text": "Want me to open it?"})
    assert "[Yes]  [No thanks]" in "\n".join(shell.lines())


def test_results_are_listed():
    presenter, shell = wired()
    presenter("action", {"items": [{"title": "essay.docx", "detail": "~/Documents"}]})
    assert any("essay.docx" in line for line in shell.lines())


def test_notices_are_kept_but_bounded():
    shell = view()
    for index in range(8):
        shell.notice(f"note {index}")
    assert shell.render()["notices"] == [f"note {index}" for index in range(3, 8)]


def test_an_empty_notice_is_dropped():
    shell = view()
    shell.notice("")
    assert shell.render()["notices"] == []


def test_render_is_json_safe():
    import json

    presenter, shell = wired()
    presenter.listening()
    presenter("confirm", {"title": "Do it", "lines": ["a"]})
    json.dumps(shell.render())
