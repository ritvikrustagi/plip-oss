"""Hold-to-talk on Windows, without watching what you type.

``ChordDetector`` (buddy/hotkey.py) is already OS-neutral: it wants a
modifier bitmask. macOS feeds it from a Quartz event tap. Windows feeds it
from ``GetAsyncKeyState`` on exactly four keys - Ctrl, Alt, Shift, Win -
polled on a background thread. That is a deliberate choice over
``SetWindowsHookEx``/``WH_KEYBOARD_LL``: a low-level hook sees every
keystroke in every app, which is the one thing a learning assistant on a
student's machine must not do. The cost is one behaviour Plip gives up:
on macOS a letter typed during the chord cancels the press (it was another
app's shortcut), and here Plip can't tell, so it doesn't claim to.

Chord names are shared with macOS so Settings and prefs stay portable;
``describe`` renders them the way Windows writes them (Ctrl, Alt, Win).
"""
from __future__ import annotations

import threading
from collections.abc import Callable

from mcp_vision.buddy.hotkey import COMMAND, CONTROL, OPTION, SHIFT, Chord, chord
from mcp_vision.buddy.win32 import VK_CONTROL, VK_LWIN, VK_MENU, VK_SHIFT, Win32Input

POLL_INTERVAL = 0.02            # 50 Hz: fast enough that a quick hold is never missed

# The mac bit Plip already uses -> the Windows key that means the same thing.
# Option is Alt; Command is the Windows key (it is only ever a chord member here).
WATCHED = ((CONTROL, VK_CONTROL), (OPTION, VK_MENU), (SHIFT, VK_SHIFT), (COMMAND, VK_LWIN))

WINDOWS_NAMES = {CONTROL: "Ctrl", OPTION: "Alt", SHIFT: "Shift", COMMAND: "Win"}
MAC_NAMES = {CONTROL: "Control", OPTION: "Option", SHIFT: "Shift", COMMAND: "Command"}


def describe(name: str | None, platform: str = "windows") -> dict:
    """The card the shell shows: ``{"id", "keys", "label"}`` in this OS's words."""
    picked = chord(name)
    names = WINDOWS_NAMES if platform == "windows" else MAC_NAMES
    keys = [names[bit] for bit, _ in WATCHED if picked.mask & bit]
    return {"id": picked.id, "keys": keys, "label": " + ".join(keys)}


def flags_from(state: Callable[[int], bool]) -> int:
    """Mac-style modifier bitmask from whichever of the four keys are held."""
    return sum(bit for bit, vk in WATCHED if state(vk))


class WindowsHotkeyListener:
    """Poll the modifiers on a thread and feed ``detector`` on the UI thread.

    ``on_main`` hops each change onto the shell's thread, the same contract the
    macOS listener has with AppKit. ``mode()`` answers "polling" or "none" so
    the shell can grey push-to-talk out with a reason.
    """

    def __init__(self, detector, *, input_api=None, on_main: Callable[[Callable[[], None]], None] | None = None,
                 interval: float = POLL_INTERVAL, sleep=None):
        self.detector = detector
        self.input = Win32Input(input_api) if input_api is not None else Win32Input()
        self.on_main = on_main or (lambda job: job())
        self.interval = interval
        self.mechanism = "none"
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._sleep = sleep or self._stop.wait
        self._flags = -1

    def start(self) -> str:
        if not self.input.available:
            self.mechanism = "none"
            return "none"
        self._stop.clear()
        self.mechanism = "polling"
        self._thread = threading.Thread(target=self._loop, daemon=True, name="plip-hotkey")
        self._thread.start()
        return self.mechanism

    def mode(self) -> str:
        """Windows needs no permission for this, so it either runs or user32 is missing."""
        if not self.input.available:
            return "none"
        return self.mechanism

    def stop(self) -> None:
        self._stop.set()
        self.mechanism = "none"

    def poll_once(self) -> int:
        """One sample; tells the detector only when the held set changed."""
        flags = flags_from(self.input.key_state)
        if flags != self._flags:
            self._flags = flags
            self.on_main(lambda: self.detector.flags_changed(flags))
        return flags

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.poll_once()
            except Exception:                   # pragma: no cover - a transient user32 failure
                pass
            self._sleep(self.interval)


def keyboard_owner() -> str:
    """Windows hands Plip the modifier state with no permission prompt."""
    return "Plip"


def can_listen(input_api=None) -> bool:
    return Win32Input(input_api).available if input_api is not None else Win32Input().available


__all__ = ["Chord", "POLL_INTERVAL", "WATCHED", "WINDOWS_NAMES", "WindowsHotkeyListener", "can_listen",
           "describe", "flags_from", "keyboard_owner"]
