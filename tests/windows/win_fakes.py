"""Stand-ins for the Windows APIs, so the Windows port is tested on any machine."""
from __future__ import annotations

import sys

# These tests run on Macs, Linux boxes and (in CI) real Windows runners. A handful of them
# assert that user32 is *missing*, which is only true off Windows; they skip on Windows,
# where the real thing is there and the same assertion would be a lie.
ON_WINDOWS = sys.platform == "win32"
OFF_WINDOWS_ONLY = ("this asserts user32 is absent, which is only true off Windows")


class FakeUser32:
    """Records what would have gone to ``user32``: input batches, moves, key state."""

    def __init__(self, cursor=(100, 200), held=(), sent_ok=True):
        self.batches: list[list] = []
        self._cursor = cursor
        self._held = set(held)
        self.sent_ok = sent_ok
        self.moved: list[tuple[int, int]] = []
        self.asked: list[int] = []

    def SendInput(self, count, array, size):
        self.batches.append([array[index] for index in range(count)])
        return count if self.sent_ok else 0

    def GetCursorPos(self, pointer):
        pointer._obj.x, pointer._obj.y = self._cursor
        return 1

    def SetCursorPos(self, x, y):
        self.moved.append((x, y))
        self._cursor = (x, y)
        return 1

    def GetAsyncKeyState(self, vk):
        self.asked.append(vk)
        return 0x8000 if vk in self._held else 0

    def hold(self, *keys) -> None:
        self._held = set(keys)

    @property
    def events(self) -> list:
        return [event for batch in self.batches for event in batch]


class FakeWindow:
    """One window in ``FakeWin32UI``: a class, a caption, a rectangle, a style."""

    def __init__(self, handle, cls="button", text="", box=(0, 0, 10, 10), style=0, children=()):
        self.handle = handle
        self.cls = cls
        self.text = text
        self.box = box
        self.style = style
        self.children = list(children)


class FakeWin32UI:
    """The slice of user32 ``WindowsUIContext`` reads, with a made-up window tree."""

    def __init__(self, windows, foreground=1, focused=0):
        self.windows = {window.handle: window for window in windows}
        self.foreground = foreground
        self.focused = focused
        self.read_text_of: list[int] = []

    def GetForegroundWindow(self):
        return self.foreground

    def GetFocus(self):
        return self.focused

    def _win(self, handle):
        return self.windows.get(int(handle) if handle else 0)

    def GetWindowRect(self, handle, pointer):
        window = self._win(handle)
        if window is None:
            return 0
        left, top, width, height = window.box
        box = pointer._obj
        box.left, box.top, box.right, box.bottom = left, top, left + width, top + height
        return 1

    def GetWindowTextLengthW(self, handle):
        window = self._win(handle)
        return len(window.text) if window else 0

    def GetWindowTextW(self, handle, buffer, size):
        window = self._win(handle)
        self.read_text_of.append(int(handle))
        buffer.value = (window.text if window else "")[: size - 1]
        return len(buffer.value)

    def GetClassNameW(self, handle, buffer, size):
        window = self._win(handle)
        buffer.value = (window.cls if window else "")[: size - 1]
        return len(buffer.value)

    def GetWindowLongW(self, handle, index):
        window = self._win(handle)
        return window.style if window else 0

    def GetWindowThreadProcessId(self, handle, pointer):
        pointer._obj.value = 0          # no process lookup in the fake; app name comes from the title
        return 1

    def EnumChildWindows(self, handle, callback, param):
        window = self._win(handle)
        for child in (window.children if window else []):
            if not callback(child.handle, param):
                break
        return 1
