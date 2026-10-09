"""Push-to-talk on Windows: the same chord rules, read from four keys only."""
from __future__ import annotations

from mcp_vision.buddy.hotkey import CHORDS, COMMAND, OPTION, ChordDetector, chord
from mcp_vision.buddy.hotkey_windows import (
    WATCHED, WindowsHotkeyListener, can_listen, describe, flags_from, keyboard_owner,
)
from mcp_vision.buddy.win32 import VK, VK_CONTROL, VK_LWIN, VK_MENU, VK_SHIFT
from win_fakes import ON_WINDOWS, FakeUser32


def detector(events: list):
    return ChordDetector(on_press=lambda: events.append("press"),
                         on_release=lambda: events.append("release"),
                         on_cancel=lambda: events.append("cancel"),
                         chord=chord("control+option").mask)


def listener(api, events, **options):
    return WindowsHotkeyListener(detector(events), input_api=api, sleep=lambda _s: None, **options)


# -- the mapping -----------------------------------------------------------------
def test_only_four_keys_are_ever_watched():
    assert [vk for _, vk in WATCHED] == [VK_CONTROL, VK_MENU, VK_SHIFT, VK_LWIN]


def test_polling_asks_about_nothing_else():
    api = FakeUser32()
    listener(api, []).poll_once()
    assert set(api.asked) == {VK_CONTROL, VK_MENU, VK_SHIFT, VK_LWIN}, \
        "anything more than the modifiers would be keystroke monitoring"
    assert VK["a"] not in api.asked


def held(*keys):
    """``GetAsyncKeyState``-shaped callable with exactly these keys down."""
    from mcp_vision.buddy.win32 import Win32Input

    return Win32Input(FakeUser32(held=set(keys))).key_state


def test_flags_match_the_macos_bitmask():
    assert flags_from(held(VK_CONTROL, VK_MENU)) == chord("control+option").mask


def test_alt_is_option_and_win_is_command():
    assert flags_from(held(VK_MENU)) == OPTION
    assert flags_from(held(VK_LWIN)) == COMMAND
    assert flags_from(held(VK_LWIN, VK_MENU)) == chord("option+command").mask


def test_nothing_held_is_no_flags():
    assert flags_from(held()) == 0


# -- the flow --------------------------------------------------------------------
def test_holding_the_chord_presses_and_letting_go_releases():
    api, events = FakeUser32(), []
    watcher = listener(api, events)
    api.hold(VK_CONTROL, VK_MENU)
    watcher.poll_once()
    assert events == ["press"]
    api.hold()
    watcher.poll_once()
    assert events == ["press", "release"]


def test_an_unchanged_sample_says_nothing():
    api, events = FakeUser32(held={VK_CONTROL, VK_MENU}), []
    watcher = listener(api, events)
    watcher.poll_once()
    watcher.poll_once()
    watcher.poll_once()
    assert events == ["press"], "only changes reach the detector"


def test_another_apps_shortcut_does_not_count():
    api, events = FakeUser32(held={VK_CONTROL, VK_MENU, VK_LWIN}), []
    listener(api, events).poll_once()
    assert events == [], "Win joined the chord: that's someone else's shortcut"


def test_adding_command_mid_press_cancels():
    api, events = FakeUser32(), []
    watcher = listener(api, events)
    api.hold(VK_CONTROL, VK_MENU)
    watcher.poll_once()
    api.hold(VK_CONTROL, VK_MENU, VK_LWIN)
    watcher.poll_once()
    assert events == ["press", "cancel"]


def test_a_stray_shift_is_tolerated():
    api, events = FakeUser32(held={VK_CONTROL, VK_MENU, VK_SHIFT}), []
    listener(api, events).poll_once()
    assert events == ["press"]


def test_changes_go_through_on_main():
    api, events, jobs = FakeUser32(), [], []
    watcher = listener(api, events, on_main=jobs.append)
    api.hold(VK_CONTROL, VK_MENU)
    watcher.poll_once()
    assert events == [] and len(jobs) == 1, "the UI thread runs it, not the polling thread"
    jobs[0]()
    assert events == ["press"]


# -- availability ----------------------------------------------------------------
def test_no_user32_means_no_push_to_talk():
    watcher = WindowsHotkeyListener(detector([]), input_api=None)
    watcher.input.api = None
    assert watcher.start() == "none" and watcher.mode() == "none"


def test_with_user32_it_polls():
    watcher = listener(FakeUser32(), [])
    assert watcher.start() == "polling" and watcher.mode() == "polling"
    watcher.stop()
    assert watcher.mode() == "none"


def test_windows_needs_no_permission_prompt():
    assert keyboard_owner() == "Plip", "unlike macOS, nothing has to be granted first"
    assert can_listen(FakeUser32()) is True
    assert can_listen() is ON_WINDOWS, "this machine's answer, not a guess"


# -- how it is described ---------------------------------------------------------
def test_chords_read_in_windows_words():
    assert describe("control+option") == {"id": "control+option", "keys": ["Ctrl", "Alt"],
                                          "label": "Ctrl + Alt"}
    assert describe("option+command")["label"] == "Alt + Win"


def test_every_settings_chord_renders():
    for name in CHORDS:
        card = describe(name)
        assert card["keys"] and card["label"], name


def test_an_unknown_chord_falls_back_like_macos():
    assert describe("hyper+meta")["id"] == "control+option"


def test_the_mac_rendering_still_uses_mac_words():
    assert describe("control+option", platform="macos")["label"] == "Control + Option"
