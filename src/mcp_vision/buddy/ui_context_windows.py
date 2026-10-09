"""Screen context on Windows: which window is in front, and its Win32 controls.

This is the grounding layer macOS gets from the Accessibility tree, and it is
much thinner here on purpose. It reads:

* the foreground window's title and the process that owns it,
* that window's rectangle,
* its child windows: class name, caption and rectangle.

It does not read, and must not be made to read:

* the contents of anything you type into. A ``WM_GETTEXT`` on an ``Edit``
  control is input capture, so child captions are only kept for classes that
  are labels and buttons, and any child with ``ES_PASSWORD`` set is dropped
  entirely - not just its text.
* URLs. A browser's address bar is an edit control, so it falls under the rule
  above; browser and Electron windows report ``blind=True`` instead, exactly
  as the macOS reader does before a page exposes itself.

The result is a ``ScreenContext`` the model already understands, so the prompt,
the snapper and the island need no Windows-specific code. The honest limit is
in ``platforms``: Win32 dialogs and classic apps map well, modern UWP /
Electron / browser content does not map at all until a UI Automation reader
lands.
"""
from __future__ import annotations

import ctypes
import os

from mcp_vision.buddy.geometry import Rect
from mcp_vision.buddy.screen_context import Control, ScreenContext, looks_secret
from mcp_vision.buddy.win32 import RECT, user32

MAX_CHILDREN = 400              # enumeration stops here; deep trees aren't worth the time
MIN_VISIBLE = 4                 # px: thinner than this isn't pointable
ES_PASSWORD = 0x0020
GWL_STYLE = -16
WS_VISIBLE = 0x10000000

# Child window classes whose caption is a label Plip may read, and the role to call it.
CLASS_ROLES = {
    "button": "button",
    "static": "text",
    "combobox": "popup button",
    "listbox": "list",
    "syslistview32": "list",
    "systreeview32": "outline",
    "systabcontrol32": "tab group",
    "msctls_progress32": "progress indicator",
    "scrollbar": "scroll bar",
    "toolbarwindow32": "toolbar",
}
# Classes that are boxes you type in: Plip keeps the box (so it can click it) and never its text.
TYPED_CLASSES = {"edit", "richedit", "richedit20w", "richedit50w", "richedit20a"}
# Front ends whose real content lives in a web view: the map is blind, and says so.
BLIND_PROCESSES = {"chrome.exe", "msedge.exe", "firefox.exe", "brave.exe", "opera.exe", "vivaldi.exe",
                   "arc.exe", "iexplore.exe", "electron.exe", "code.exe", "slack.exe", "discord.exe",
                   "teams.exe", "ms-teams.exe", "spotify.exe", "notion.exe", "figma.exe",
                   "applicationframehost.exe"}


def _rect(api, handle) -> Rect | None:
    box = RECT()
    if not api.GetWindowRect(handle, ctypes.byref(box)):
        return None
    width, height = box.right - box.left, box.bottom - box.top
    if width <= 0 or height <= 0:
        return None
    return Rect(float(box.left), float(box.top), float(width), float(height))


def _text(api, handle, limit: int = 120) -> str:
    length = int(api.GetWindowTextLengthW(handle))
    if length <= 0:
        return ""
    buffer = ctypes.create_unicode_buffer(min(length, limit) + 1)
    api.GetWindowTextW(handle, buffer, len(buffer))
    return " ".join(buffer.value.split())


def _class_name(api, handle) -> str:
    buffer = ctypes.create_unicode_buffer(128)
    api.GetClassNameW(handle, buffer, len(buffer))
    return buffer.value


def _process_name(api, handle) -> str:
    """The .exe that owns a window, so browsers can be recognised. Best effort."""
    try:
        import ctypes.wintypes as wintypes

        pid = wintypes.DWORD(0)
        api.GetWindowThreadProcessId(handle, ctypes.byref(pid))
        kernel = getattr(ctypes, "windll", None)
        if kernel is None or not pid.value:
            return ""
        handle32 = kernel.kernel32.OpenProcess(0x1000, False, pid.value)     # QUERY_LIMITED_INFORMATION
        if not handle32:
            return ""
        try:
            size = wintypes.DWORD(260)
            buffer = ctypes.create_unicode_buffer(size.value)
            if kernel.kernel32.QueryFullProcessImageNameW(handle32, 0, buffer, ctypes.byref(size)):
                return os.path.basename(buffer.value)
        finally:
            kernel.kernel32.CloseHandle(handle32)
    except Exception:
        return ""
    return ""


def app_name(process: str, title: str) -> str:
    """"chrome.exe" -> "Chrome"; falls back to the window title's tail ("... - Word")."""
    if process:
        stem = os.path.splitext(process)[0]
        pretty = {"msedge": "Microsoft Edge", "chrome": "Chrome", "firefox": "Firefox", "explorer": "File Explorer",
                  "winword": "Word", "excel": "Excel", "powerpnt": "PowerPoint", "code": "VS Code",
                  "ms-teams": "Teams", "applicationframehost": "a Windows app"}
        return pretty.get(stem.lower(), stem.replace("_", " ").title())
    if " - " in title:
        return title.rsplit(" - ", 1)[-1].strip()
    return ""


class WindowsUIContext:
    """``snapshot()`` returns a ``ScreenContext``; safe to call from a worker thread."""

    def __init__(self, api=None, *, max_children: int = MAX_CHILDREN):
        self.api = api if api is not None else user32()
        self.max_children = max_children

    @property
    def available(self) -> bool:
        return self.api is not None

    def snapshot(self) -> ScreenContext:
        if self.api is None:
            return ScreenContext()
        try:
            return self._read()
        except Exception:
            return ScreenContext()

    def _read(self) -> ScreenContext:
        api = self.api
        window = api.GetForegroundWindow()
        if not window:
            return ScreenContext()
        title = _text(api, window, limit=200)
        process = _process_name(api, window)
        frame = _rect(api, window)
        blind = process.lower() in BLIND_PROCESSES
        controls, texts = ([], []) if blind else self._children(window, frame)
        return ScreenContext(
            app=app_name(process, title),
            window=title,
            controls=controls,
            texts=texts,
            focused=self._focused(),
            blind=blind,
            window_frame=frame,
        )

    def _focused(self) -> str:
        """What kind of thing has focus, never what is in it."""
        api = self.api
        try:
            handle = api.GetFocus()
        except Exception:
            return ""
        if not handle:
            return ""
        name = _class_name(api, handle).lower()
        if name in TYPED_CLASSES:
            return "text box" if not self._secure(handle) else "password box"
        return CLASS_ROLES.get(name, "")

    def _secure(self, handle) -> bool:
        try:
            style = int(self.api.GetWindowLongW(handle, GWL_STYLE))
        except Exception:
            return True                     # can't tell: treat it as a password box and keep out
        return bool(style & ES_PASSWORD)

    def _children(self, window, frame: Rect | None) -> tuple[list[Control], list[Control]]:
        handles = self._enumerate(window)
        controls: list[Control] = []
        texts: list[Control] = []
        for handle in handles:
            box = _rect(self.api, handle)
            if box is None or box.width < MIN_VISIBLE or box.height < MIN_VISIBLE:
                continue
            if frame is not None and not frame.contains(box.x + box.width / 2, box.y + box.height / 2):
                continue                    # scrolled or clipped out of its window
            name = _class_name(self.api, handle).lower()
            typed = name in TYPED_CLASSES
            if typed and self._secure(handle):
                continue                    # a password box: not its value, not even its existence
            label = "" if typed else _text(self.api, handle)
            if looks_secret(label):
                continue                    # labelled like a code, card or key: leave it out
            control = Control(label=label, role="text box" if typed else CLASS_ROLES.get(name, "button"),
                              x=box.x + box.width / 2, y=box.y + box.height / 2,
                              w=box.width, h=box.height, value="", secure=False)
            if control.role == "text" and label:
                texts.append(control)
            elif label or typed:
                controls.append(control)
        return controls[:90], texts[:60]

    def _enumerate(self, window) -> list:
        """Direct and nested children, breadth first, capped."""
        found: list = []
        proto = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)

        @proto
        def visit(handle, _param):
            found.append(handle)
            return 0 if len(found) >= self.max_children else 1

        self.api.EnumChildWindows(window, visit, 0)
        return found


def make_windows_context(api=None) -> WindowsUIContext | None:
    """``None`` when user32 isn't reachable, so the caller can grey grounding out."""
    context = WindowsUIContext(api)
    return context if context.available else None


__all__ = ["BLIND_PROCESSES", "CLASS_ROLES", "TYPED_CLASSES", "WindowsUIContext", "app_name",
           "make_windows_context"]
