"""The small slice of Win32 Plip needs, behind one object that tests can fake.

Nothing in here is imported on macOS: ``user32()`` returns ``None`` unless
``ctypes.windll`` exists. The structures and the key tables are plain
``ctypes``, so they can be built and checked on any OS, which is how the
Windows input path is tested without a Windows machine.

What Plip deliberately does *not* do here: no keyboard hook, no
``GetWindowText`` on an edit control, no clipboard read. Push-to-talk polls
the four modifier keys with ``GetAsyncKeyState`` and nothing else, so Plip
cannot see what you type.
"""
from __future__ import annotations

import ctypes
from dataclasses import dataclass

# -- SendInput -----------------------------------------------------------------------
INPUT_MOUSE = 0
INPUT_KEYBOARD = 1

KEYEVENTF_EXTENDEDKEY = 0x0001
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004

MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_MIDDLEDOWN = 0x0020
MOUSEEVENTF_MIDDLEUP = 0x0040
MOUSEEVENTF_WHEEL = 0x0800
MOUSEEVENTF_HWHEEL = 0x01000
MOUSEEVENTF_ABSOLUTE = 0x8000
WHEEL_DELTA = 120

SM_CXSCREEN, SM_CYSCREEN = 0, 1

ULONG_PTR = ctypes.c_uint64 if ctypes.sizeof(ctypes.c_void_p) == 8 else ctypes.c_uint32


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", ctypes.c_long), ("dy", ctypes.c_long), ("mouseData", ctypes.c_ulong),
                ("dwFlags", ctypes.c_ulong), ("time", ctypes.c_ulong), ("dwExtraInfo", ULONG_PTR)]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", ctypes.c_ushort), ("wScan", ctypes.c_ushort), ("dwFlags", ctypes.c_ulong),
                ("time", ctypes.c_ulong), ("dwExtraInfo", ULONG_PTR)]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [("uMsg", ctypes.c_ulong), ("wParamL", ctypes.c_ushort), ("wParamH", ctypes.c_ushort)]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", ctypes.c_ulong), ("u", _INPUTUNION)]


class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long), ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


def key_input(vk: int, *, up: bool = False, scan: int = 0, unicode_char: bool = False) -> INPUT:
    flags = (KEYEVENTF_UNICODE if unicode_char else 0) | (KEYEVENTF_KEYUP if up else 0)
    event = INPUT(type=INPUT_KEYBOARD)
    event.ki = KEYBDINPUT(wVk=0 if unicode_char else vk, wScan=scan if unicode_char else 0,
                          dwFlags=flags, time=0, dwExtraInfo=0)
    return event


def unicode_inputs(text: str) -> list[INPUT]:
    """Down/up pairs that type ``text`` literally, whatever keyboard layout is active.

    Characters outside the BMP go as their two UTF-16 surrogates, which is what
    ``KEYEVENTF_UNICODE`` expects.
    """
    events: list[INPUT] = []
    for char in text:
        encoded = char.encode("utf-16-le")
        for index in range(0, len(encoded), 2):
            unit = int.from_bytes(encoded[index:index + 2], "little")
            events.append(key_input(0, scan=unit, unicode_char=True))
            events.append(key_input(0, scan=unit, unicode_char=True, up=True))
    return events


def mouse_input(flags: int, *, dx: int = 0, dy: int = 0, data: int = 0) -> INPUT:
    event = INPUT(type=INPUT_MOUSE)
    event.mi = MOUSEINPUT(dx=dx, dy=dy, mouseData=ctypes.c_ulong(data & 0xFFFFFFFF).value,
                          dwFlags=flags, time=0, dwExtraInfo=0)
    return event


BUTTONS = {"left": (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
           "right": (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
           "middle": (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP)}


def click_inputs(button: str = "left", count: int = 1) -> list[INPUT]:
    down, up = BUTTONS.get(button, BUTTONS["left"])
    events: list[INPUT] = []
    for _ in range(max(1, int(count))):
        events.append(mouse_input(down))
        events.append(mouse_input(up))
    return events


def wheel_inputs(dy: int = 0, dx: int = 0) -> list[INPUT]:
    """``dy`` lines, positive = scroll down (as the rest of Plip means it)."""
    events: list[INPUT] = []
    if dy:
        events.append(mouse_input(MOUSEEVENTF_WHEEL, data=-int(dy) * WHEEL_DELTA))
    if dx:
        events.append(mouse_input(MOUSEEVENTF_HWHEEL, data=int(dx) * WHEEL_DELTA))
    return events


# -- keys ----------------------------------------------------------------------------
# Virtual-key codes. Plip's action vocabulary is written for a Mac ("cmd+t"), so the
# Windows side maps Command onto Control: that is what the same shortcut is called here.
VK = {
    "return": 0x0D, "enter": 0x0D, "tab": 0x09, "space": 0x20, "delete": 0x08, "backspace": 0x08,
    "escape": 0x1B, "esc": 0x1B, "forwarddelete": 0x2E, "home": 0x24, "end": 0x23,
    "pageup": 0x21, "pagedown": 0x22, "left": 0x25, "up": 0x26, "right": 0x27, "down": 0x28,
    "f1": 0x70, "f2": 0x71, "f3": 0x72, "f4": 0x73, "f5": 0x74, "f6": 0x75, "f7": 0x76, "f8": 0x77,
    "f9": 0x78, "f10": 0x79, "f11": 0x7A, "f12": 0x7B,
    "=": 0xBB, "-": 0xBD, "[": 0xDB, "]": 0xDD, "\\": 0xDC, ";": 0xBA, "'": 0xDE,
    ",": 0xBC, ".": 0xBE, "/": 0xBF, "`": 0xC0,
}
VK.update({letter: 0x41 + index for index, letter in enumerate("abcdefghijklmnopqrstuvwxyz")})
VK.update({str(digit): 0x30 + digit for digit in range(10)})

VK_SHIFT, VK_CONTROL, VK_MENU, VK_LWIN = 0x10, 0x11, 0x12, 0x5B
EXTENDED = {0x25, 0x26, 0x27, 0x28, 0x21, 0x22, 0x24, 0x23, 0x2E}   # arrows, paging, forward delete

# What a Mac modifier means on Windows. Command has no counterpart; every Mac app shortcut
# it appears in ("cmd+t", "cmd+s") is Ctrl here, so that is where it goes.
MODIFIER_VK = {"cmd": VK_CONTROL, "command": VK_CONTROL, "ctrl": VK_CONTROL, "control": VK_CONTROL,
               "shift": VK_SHIFT, "alt": VK_MENU, "option": VK_MENU, "opt": VK_MENU,
               "win": VK_LWIN, "super": VK_LWIN}
KEY_ALIASES = {"plus": "=", "minus": "-", "zoomin": "=", "zoomout": "-"}


@dataclass(frozen=True)
class Combo:
    key: int
    modifiers: tuple[int, ...] = ()
    extended: bool = False

    def inputs(self) -> list[INPUT]:
        flags = KEYEVENTF_EXTENDEDKEY if self.extended else 0
        events = [key_input(vk) for vk in self.modifiers]
        events.append(key_input(self.key))
        events[-1].ki.dwFlags |= flags
        tail = key_input(self.key, up=True)
        tail.ki.dwFlags |= flags
        events.append(tail)
        events.extend(key_input(vk, up=True) for vk in reversed(self.modifiers))
        return events


def parse_combo(keys: str) -> Combo:
    """"cmd+shift+t" -> the Windows combo (Ctrl+Shift+T). Raises ``ValueError``."""
    compact = keys.replace(" ", "").lower()
    if compact.endswith("++"):
        compact = compact[:-1] + "="
    parts = [part for part in compact.split("+") if part]
    if not parts:
        raise ValueError("no key")
    modifiers = []
    for part in parts[:-1]:
        vk = MODIFIER_VK.get(part)
        if vk is None:
            raise ValueError(f"unknown modifier {part}")
        if vk not in modifiers:
            modifiers.append(vk)
    name = KEY_ALIASES.get(parts[-1], parts[-1])
    if name not in VK:
        raise ValueError(f"unknown key {name}")
    key = VK[name]
    return Combo(key, tuple(modifiers), key in EXTENDED)


# -- the library ---------------------------------------------------------------------
def user32():
    """``ctypes.windll.user32``, or ``None`` anywhere that isn't Windows."""
    windll = getattr(ctypes, "windll", None)
    if windll is None:
        return None
    try:
        return windll.user32
    except Exception:          # pragma: no cover - Windows only
        return None


class Win32Input:
    """Sends input and reads the pointer. ``api`` is injected in tests."""

    def __init__(self, api=None):
        self.api = api if api is not None else user32()

    @property
    def available(self) -> bool:
        return self.api is not None

    def send(self, events: list[INPUT]) -> int:
        if not events:
            return 0
        if self.api is None:
            raise RuntimeError("user32 is not available on this system")
        array = (INPUT * len(events))(*events)
        return int(self.api.SendInput(len(events), array, ctypes.sizeof(INPUT)))

    def cursor(self) -> tuple[float, float] | None:
        if self.api is None:
            return None
        point = POINT()
        if not self.api.GetCursorPos(ctypes.byref(point)):
            return None
        return float(point.x), float(point.y)

    def move(self, x: float, y: float) -> None:
        if self.api is None:
            raise RuntimeError("user32 is not available on this system")
        self.api.SetCursorPos(int(round(x)), int(round(y)))

    def key_state(self, vk: int) -> bool:
        """Is this key held right now? Only ever called with a modifier."""
        if self.api is None:
            return False
        return bool(self.api.GetAsyncKeyState(vk) & 0x8000)


__all__ = ["Combo", "INPUT", "KEYBDINPUT", "MODIFIER_VK", "MOUSEINPUT", "POINT", "RECT", "VK", "VK_CONTROL",
           "VK_LWIN", "VK_MENU", "VK_SHIFT", "WHEEL_DELTA", "Win32Input", "click_inputs", "key_input",
           "mouse_input", "parse_combo", "unicode_inputs", "user32", "wheel_inputs"]
