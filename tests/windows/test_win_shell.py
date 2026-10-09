"""``WindowsShell``: the wiring, driven with fakes instead of Windows.

These are the tests that say the port kept the behaviour that matters: a chat
turn works, the walkthrough checklist fills in, a consequential action waits
for a yes, screenshots are refused until the session allows them, and the
learning log records the turn only when a session is running.
"""
from __future__ import annotations

import asyncio
import threading
import time

import pytest
from buddy_fakes import Capturer, Events, ScriptedBrain, shot
from win_fakes import FakeUser32

from mcp_vision.buddy.companion import Companion
from mcp_vision.buddy.conversation import Conversation
from mcp_vision.buddy.gated_capture import GatedCapturer, GatedContext
from mcp_vision.buddy.screen_context import ScreenContext
from mcp_vision.buddy.settings import BuddySettings
from mcp_vision.buddy.shell_windows import WindowsShell
from mcp_vision.buddy.store import Prefs
from mcp_vision.learning.consent import SessionConsent
from mcp_vision.learning.log import LearningLog
from mcp_vision.learning.session import LearningSession
from mcp_vision.platforms import capabilities


class Listener:
    """A fake microphone: ``start``/``release`` with a scripted transcript."""

    name = "fake"
    tail = 0

    def __init__(self, transcript="how do I add a table"):
        self.transcript = transcript
        self.events = []

    def start(self):
        self.events.append("start")

    def release(self):
        self.events.append("release")

    def cancel(self):
        self.events.append("cancel")


@pytest.fixture
def shell(tmp_path, monkeypatch):
    """A shell with a scripted brain, a fake mic and its own learning log."""
    monkeypatch.setenv("MCP_VISION_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("MCP_VISION_CONFIG_DIR", str(tmp_path / "config"))
    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()
    consent = SessionConsent()
    built = WindowsShell(
        settings=BuddySettings(tts="off"), prefs=Prefs(), loop=loop,
        caps=capabilities("win32"), consent=consent,
        learning=LearningSession(log=LearningLog(path=tmp_path / "events.jsonl"), consent=consent,
                                 student_id="stu_test", platform="windows"),
    )
    yield built
    loop.call_soon_threadsafe(loop.stop)


def companion(shell, *replies, capturer=None, context=None, actions=None) -> Companion:
    observer = Events()
    turn = Companion(brain=ScriptedBrain(*replies), capturer=capturer or Capturer(),
                     speaker=None, conversation=Conversation(max_turns=10),
                     observer=lambda kind, data: (shell.presenter(kind, data), observer(kind, data)),
                     router=None, context=context, actions=actions)
    shell.controller.companion = turn
    shell.controller.setup_error = ""
    shell.setup_error = ""
    return turn


def settle(shell, deadline=3.0):
    """Wait for the turn to finish and the view to catch up."""
    end = time.monotonic() + deadline
    while time.monotonic() < end:
        if shell.controller.state == "idle" and shell.view.island.get("done"):
            return
        time.sleep(0.02)


# -- a chat turn -------------------------------------------------------------------
def test_a_typed_question_goes_through_and_comes_back(shell):
    companion(shell, "Insert, then Table.")
    shell.ask("how do I add a table")
    settle(shell)
    assert shell.view.render()["transcript"] == "how do I add a table"
    assert "Insert, then Table." in shell.view.render()["answer"]


def test_blank_input_is_ignored(shell):
    turn = companion(shell, "hello")
    shell.ask("   ")
    assert turn.brain.calls == []


def test_typing_works_with_no_microphone_at_all(shell):
    companion(shell, "Sure.")
    shell.controller.listener = None
    shell.ask("hello")
    settle(shell)
    assert "Sure." in shell.view.render()["answer"]


def test_push_to_talk_runs_the_same_turn(shell):
    companion(shell, "Insert, then Table.")
    shell.controller.listener = Listener()
    shell.controller.press_delay = 0
    shell.controller.on_press()
    assert shell.view.render()["phase"] == "listening"
    shell.controller.on_partial("how do I")
    assert "how do I" in shell.view.render()["transcript"]
    shell.controller.on_release()
    shell.controller.on_final("how do I add a table")
    settle(shell)
    assert "Insert, then Table." in shell.view.render()["answer"]


def test_the_turn_is_kept_in_the_local_history(shell, tmp_path):
    from mcp_vision.buddy.store import History

    shell.history = History(path=tmp_path / "history.jsonl")
    companion(shell, "Insert, then Table.")
    shell.ask("how do I add a table")
    settle(shell)
    assert [item["question"] for item in shell.history.items()] == ["how do I add a table"]


def test_stopping_mid_turn_leaves_the_strip_idle(shell):
    companion(shell, "a long answer")
    shell.controller.listener = Listener()
    shell.controller.press_delay = 0
    shell.controller.on_press()
    shell.stop()
    assert shell.controller.state == "idle"
    assert shell.view.render()["phase"] == "idle"


def test_clearing_forgets_the_conversation(shell):
    turn = companion(shell, "one", "two")
    shell.ask("first")
    settle(shell)
    shell.clear()
    assert turn.conversation.history() == []
    assert any("cleared" in note for note in shell.view.render()["notices"])


# -- the walkthrough checklist ------------------------------------------------------
def test_the_checklist_fills_in_as_plip_works(shell):
    companion(shell, "Here we go.")
    shell.presenter("plan", {"steps": ["Open Word", "Click Insert", "Pick Table"]})
    shell.presenter("step", {"id": "look", "label": "Looked at 1 screen", "status": "done"})
    lines = shell.view.checklist()
    assert lines[0] == "… Open Word"
    assert lines[1:3] == ["○ Click Insert", "○ Pick Table"]
    assert lines[-1] == "✓ Looked at 1 screen"


def test_a_walkthrough_shows_which_step_it_is_on(shell):
    shell.presenter("plan", {"steps": ["One", "Two"]})
    shell.presenter("walkthrough", {"index": 1, "total": 2, "label": "Two"})
    assert "step 2 of 2" in shell.view.status_line()
    assert shell.view.checklist()[:2] == ["✓ One", "… Two"]


# -- the safety card ---------------------------------------------------------------
def test_a_consequential_action_stops_and_waits(shell):
    from mcp_vision.buddy.actions import ActionContext, ActionEngine, ActionResult, ActionSpec, Preview
    from mcp_vision.buddy.actions.host import PortableHost

    ran = []
    spec = ActionSpec("tidy_desktop", "files", "Tidying your desktop",
                      run=lambda ctx, args: (ran.append(args), ActionResult(say="Tidied."))[1],
                      preview=lambda ctx, args: Preview("Tidy 12 files into folders?", ["12 files"], "Tidy it"))
    engine = ActionEngine(ActionContext(host=PortableHost()), [spec], log=None)
    companion(shell, "[DO:tidy_desktop {}]", actions=engine)
    shell.ask("tidy my desktop")
    time.sleep(0.6)
    card = shell.view.confirm_card()
    assert card is not None and card["confirm"] == "Tidy it"
    assert ran == [], "nothing runs before the yes"


def test_the_yes_button_is_what_runs_it(shell):
    from mcp_vision.buddy.actions import ActionContext, ActionEngine, ActionResult, ActionSpec, Preview
    from mcp_vision.buddy.actions.host import PortableHost

    ran = []
    spec = ActionSpec("tidy_desktop", "files", "Tidying your desktop",
                      run=lambda ctx, args: (ran.append(args), ActionResult(say="Tidied."))[1],
                      preview=lambda ctx, args: Preview("Tidy 12 files?", [], "Tidy it"))
    engine = ActionEngine(ActionContext(host=PortableHost()), [spec], log=None)
    companion(shell, "[DO:tidy_desktop {}]", actions=engine)
    shell.ask("tidy my desktop")
    time.sleep(0.6)
    shell.confirm(True)
    time.sleep(0.6)
    assert ran == [{}]


def test_the_no_button_leaves_it_undone(shell):
    from mcp_vision.buddy.actions import ActionContext, ActionEngine, ActionResult, ActionSpec, Preview
    from mcp_vision.buddy.actions.host import PortableHost

    ran = []
    spec = ActionSpec("tidy_desktop", "files", "Tidying your desktop",
                      run=lambda ctx, args: (ran.append(args), ActionResult())[1],
                      preview=lambda ctx, args: Preview("Tidy 12 files?", [], "Tidy it"))
    engine = ActionEngine(ActionContext(host=PortableHost()), [spec], log=None)
    companion(shell, "[DO:tidy_desktop {}]", actions=engine)
    shell.ask("tidy my desktop")
    time.sleep(0.6)
    shell.confirm(False)
    time.sleep(0.5)
    assert ran == [] and shell.view.confirm_card() is None


def test_confirming_with_no_companion_does_nothing(shell):
    shell.controller.companion = None
    shell.confirm(True)        # must not raise


# -- screenshots are opt-in ---------------------------------------------------------
def test_no_screenshots_until_the_session_allows_them(shell):
    inner = Capturer()
    gate = GatedCapturer(inner, allowed=lambda: shell.consent.allows("screenshots"),
                         reason=lambda: shell.consent.why_not("screenshots"))
    assert gate.capture() == [] and inner.captures == 0
    assert gate.status()["denials"] == 1 and "No learning session" in gate.status()["reason"]
    shell.start_session(screenshots=True)
    assert len(gate.capture()) == 1 and inner.captures == 1


def test_display_geometry_is_not_a_screenshot(shell):
    inner = Capturer()
    gate = GatedCapturer(inner, allowed=lambda: False)
    assert len(gate.screens()) == 1, "the router may know how many screens there are"
    assert inner.captures == 0


def test_the_other_pixel_reads_are_gated_too():
    class Rich(Capturer):
        def glance(self):
            return "image"

        def fingerprint(self):
            return b"xyz"

        def fingerprint_at(self, x, y, size=300.0):
            return b"abc"

    gate = GatedCapturer(Rich(), allowed=lambda: False)
    assert gate.glance() is None and gate.fingerprint() == b"" and gate.fingerprint_at(1, 1) is None
    assert gate.status()["denials"] == 3


def test_pausing_a_session_shuts_the_gate_again(shell):
    gate = GatedCapturer(Capturer(), allowed=lambda: shell.consent.allows("screenshots"),
                         reason=lambda: shell.consent.why_not("screenshots"))
    shell.start_session(screenshots=True)
    assert gate.capture() != []
    shell.pause_session()
    assert gate.capture() == []


def test_the_window_map_is_gated_as_well(shell):
    class Reader:
        def __init__(self):
            self.reads = 0

        def snapshot(self):
            self.reads += 1
            return ScreenContext(app="Word", window="Essay.docx")

    reader = Reader()
    gate = GatedContext(reader, allowed=lambda: shell.consent.allows("screen_context"))
    assert gate.snapshot() == ScreenContext() and reader.reads == 0
    shell.start_session(screen_context=True)
    assert gate.snapshot().app == "Word"


def test_a_turn_still_answers_with_the_gate_shut(shell):
    inner = Capturer(shots=[shot()])
    gate = GatedCapturer(inner, allowed=lambda: False)
    companion(shell, "I can't see your screen, but here's how.", capturer=gate)
    shell.ask("how do I add a table")
    settle(shell)
    assert "here's how" in shell.view.render()["answer"]
    assert inner.captures == 0


# -- the learning session ----------------------------------------------------------
def test_no_session_means_an_empty_learning_log(shell):
    shell.learning.task_started("t1")
    assert shell.learning.log.events() == []


def test_starting_a_session_from_the_shell_records_it(shell):
    shell.start_session(granted_by="student", class_id="7B", share_with_teacher=True)
    shell.learning.task_started("t1", concept_ids=["fractions"])
    types = [event.type for event in shell.learning.log.events()]
    assert types == ["session_started", "task_started"]
    assert all(event.classId == "7B" for event in shell.learning.log.events())


def test_the_switches_can_be_flipped_one_at_a_time(shell):
    shell.start_session()
    shell.toggle("screenshots")
    assert shell.consent.screenshots
    shell.toggle("screenshots")
    assert not shell.consent.screenshots


def test_flipping_a_switch_with_no_session_explains_itself(shell):
    shell.toggle("screenshots")
    assert any("No session" in note for note in shell.view.render()["notices"])
    assert not shell.consent.screenshots


def test_stopping_the_session_says_nothing_is_recorded(shell):
    shell.start_session()
    shell.stop_session()
    assert any("Nothing is being recorded" in note for note in shell.view.render()["notices"])


def test_export_hands_back_json_lines(shell):
    shell.start_session()
    shell.learning.task_started("t1")
    assert len(shell.export_learning().splitlines()) == 2


def test_delete_removes_everything_and_says_how_much(shell):
    shell.start_session()
    shell.learning.task_started("t1")
    assert shell.forget_learning() == 2
    assert shell.export_learning() == ""
    assert any("Deleted 2" in note for note in shell.view.render()["notices"])


# -- the hotkey ---------------------------------------------------------------------
def test_push_to_talk_reports_whether_it_is_listening(shell):
    from mcp_vision.buddy.hotkey_windows import WindowsHotkeyListener

    api = FakeUser32()
    mode = shell.start_hotkeys(WindowsHotkeyListener(shell.detector, input_api=api, sleep=lambda _s: None))
    assert mode == "polling"
    assert shell.view.render()["shortcut"] == {"id": "control+option", "keys": ["Ctrl", "Alt"],
                                               "label": "Ctrl + Alt", "works": True}
    shell.hotkeys.stop()


def test_without_user32_the_strip_says_push_to_talk_is_off(shell):
    from mcp_vision.buddy.hotkey_windows import WindowsHotkeyListener

    listener = WindowsHotkeyListener(shell.detector, input_api=None)
    listener.input.api = None
    assert shell.start_hotkeys(listener) == "none"
    assert shell.view.render()["shortcut"]["works"] is False


def test_the_shortcut_is_described_in_windows_words(shell):
    from mcp_vision.buddy.hotkey_windows import WindowsHotkeyListener

    shell.start_hotkeys(WindowsHotkeyListener(shell.detector, input_api=FakeUser32(), sleep=lambda _s: None))
    assert shell.controller.shortcut == "Ctrl + Alt", "not Control+Option, which is a Mac"
    shell.hotkeys.stop()


# -- shutting down ------------------------------------------------------------------
def test_shutdown_stops_the_hotkey_thread(shell):
    from mcp_vision.buddy.hotkey_windows import WindowsHotkeyListener

    shell.start_hotkeys(WindowsHotkeyListener(shell.detector, input_api=FakeUser32(), sleep=lambda _s: None))
    shell.shutdown()
    assert shell.hotkeys.mode() == "none"
