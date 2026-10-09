"""The Win32 input path, checked without Windows.

``SendInput`` structures are plain ctypes, so they can be built and inspected
on a Mac. These tests assert the bytes Plip would hand to user32: the right
virtual-key codes, the right flags, down/up pairing, and Command translated
to Control. What they cannot do is prove Windows accepts them; see
docs/WINDOWS.md.
"""
from __future__ import annotations

import pytest

from mcp_vision.buddy.win32 import (
    INPUT_KEYBOARD, INPUT_MOUSE, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSEEVENTF_HWHEEL,
    MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_WHEEL, VK,
    VK_CONTROL, VK_MENU, VK_SHIFT, WHEEL_DELTA, Win32Input, click_inputs, parse_combo,
    unicode_inputs, user32, wheel_inputs,
)
from win_fakes import OFF_WINDOWS_ONLY, ON_WINDOWS, FakeUser32


@pytest.mark.skipif(ON_WINDOWS, reason=OFF_WINDOWS_ONLY)
def test_user32_is_absent_off_windows():
    assert user32() is None
    assert not Win32Input().available


def test_user32_is_there_on_windows():
    if not ON_WINDOWS:
        pytest.skip("only a Windows runner can answer this")
    assert user32() is not None and Win32Input().available


def test_sending_without_user32_says_so():
    probe = Win32Input(FakeUser32())
    probe.api = None                      # never Win32Input(None): that means "use the real one"
    with pytest.raises(RuntimeError, match="user32"):
        probe.send(click_inputs())


# -- typing ---------------------------------------------------------------------
def test_unicode_typing_is_layout_independent():
    events = unicode_inputs("hi")
    assert len(events) == 4
    assert all(event.type == INPUT_KEYBOARD for event in events)
    assert all(event.ki.dwFlags & KEYEVENTF_UNICODE for event in events)
    assert all(event.ki.wVk == 0 for event in events), "unicode input carries the character, not a key code"
    assert [event.ki.wScan for event in events] == [ord("h"), ord("h"), ord("i"), ord("i")]
    assert [bool(event.ki.dwFlags & KEYEVENTF_KEYUP) for event in events] == [False, True, False, True]


def test_typing_handles_accents_and_emoji():
    assert [event.ki.wScan for event in unicode_inputs("é")][0] == ord("é")
    surrogates = unicode_inputs("🙂")
    assert len(surrogates) == 4, "an astral character goes as its two UTF-16 surrogates"
    assert surrogates[0].ki.wScan == 0xD83D and surrogates[2].ki.wScan == 0xDE42


def test_typing_nothing_sends_nothing():
    assert unicode_inputs("") == []
    assert Win32Input(FakeUser32()).send([]) == 0


# -- combos ---------------------------------------------------------------------
def test_command_becomes_control():
    combo = parse_combo("cmd+t")
    assert combo.modifiers == (VK_CONTROL,)
    assert combo.key == VK["t"]


def test_modifier_order_and_pairing():
    events = parse_combo("cmd+shift+t").inputs()
    assert [event.ki.wVk for event in events] == [VK_CONTROL, VK_SHIFT, VK["t"], VK["t"], VK_SHIFT, VK_CONTROL]
    ups = [bool(event.ki.dwFlags & KEYEVENTF_KEYUP) for event in events]
    assert ups == [False, False, False, True, True, True], "modifiers release after the key, in reverse"


def test_option_is_alt():
    assert parse_combo("option+f4").modifiers == (VK_MENU,)


def test_arrows_are_marked_extended():
    assert parse_combo("down").extended
    assert not parse_combo("a").extended
    down = parse_combo("down").inputs()[0]
    assert down.ki.dwFlags & 0x0001, "Windows needs KEYEVENTF_EXTENDEDKEY for the arrow block"


def test_plus_shorthand_matches_macos():
    assert parse_combo("cmd++").key == VK["="]
    assert parse_combo("cmd+plus").key == VK["="]
    assert parse_combo("cmd+zoomout").key == VK["-"]


def test_a_duplicate_modifier_is_pressed_once():
    assert parse_combo("cmd+ctrl+s").modifiers == (VK_CONTROL,)


@pytest.mark.parametrize("keys", ["", "hyper+t", "cmd+nope", "+"])
def test_bad_combos_raise(keys):
    with pytest.raises(ValueError):
        parse_combo(keys)


def test_every_macos_key_name_also_parses_on_windows():
    from mcp_vision.buddy.actions.host import KEY_CODES

    # The model is told one key vocabulary; both hosts must accept all of it.
    unparseable = []
    for name in KEY_CODES:
        try:
            parse_combo(name)
        except ValueError:
            unparseable.append(name)
    assert unparseable == [], f"these keys work on macOS but not Windows: {unparseable}"


# -- mouse ----------------------------------------------------------------------
def test_click_is_a_down_up_pair():
    events = click_inputs()
    assert [event.mi.dwFlags for event in events] == [MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP]
    assert all(event.type == INPUT_MOUSE for event in events)


def test_double_click_sends_two_pairs():
    assert len(click_inputs(count=2)) == 4


def test_right_click():
    assert click_inputs("right")[0].mi.dwFlags == MOUSEEVENTF_RIGHTDOWN


def test_unknown_button_falls_back_to_left():
    assert click_inputs("pinky")[0].mi.dwFlags == MOUSEEVENTF_LEFTDOWN


def test_scrolling_down_is_a_negative_wheel_delta():
    # Plip's convention is "positive dy = scroll down"; Windows' wheel is the other way round.
    event = wheel_inputs(dy=3)[0]
    assert event.mi.dwFlags == MOUSEEVENTF_WHEEL
    assert event.mi.mouseData == (-3 * WHEEL_DELTA) & 0xFFFFFFFF


def test_horizontal_scroll_keeps_its_sign():
    event = wheel_inputs(dx=2)[0]
    assert event.mi.dwFlags == MOUSEEVENTF_HWHEEL
    assert event.mi.mouseData == 2 * WHEEL_DELTA


def test_no_scroll_no_events():
    assert wheel_inputs() == []


# -- the wrapper ----------------------------------------------------------------
def test_cursor_reads_through_the_api():
    assert Win32Input(FakeUser32(cursor=(7, 9))).cursor() == (7.0, 9.0)


def test_move_goes_to_setcursorpos():
    api = FakeUser32()
    Win32Input(api).move(12.6, 4.2)
    assert api.moved == [(13, 4)]


def test_key_state_only_reports_what_it_is_asked():
    api = FakeUser32(held={VK_CONTROL})
    probe = Win32Input(api)
    assert probe.key_state(VK_CONTROL)
    assert not probe.key_state(VK["a"])


def test_send_reports_how_many_landed():
    api = FakeUser32()
    assert Win32Input(api).send(click_inputs()) == 2
    assert len(api.batches) == 1 and len(api.batches[0]) == 2
