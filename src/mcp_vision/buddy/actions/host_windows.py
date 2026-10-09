"""The Windows half of ``actions.host``: native tools instead of macOS ones.

What replaces what, and nothing is pretended:

====================  ==================================================
macOS                 Windows
====================  ==================================================
``open -a``           ``os.startfile`` + the Start Menu's ``.lnk`` files
``open -R``           ``explorer /select,``
``mdfind``            a filename walk of your user folders (no content search)
``osascript``         ``powershell`` for the few things Plip needs
``display notif.``    a Windows toast (``Windows.UI.Notifications``)
Quartz events         ``user32`` ``SendInput``
``shortcuts``         nothing: Apple Shortcuts have no Windows twin
AX API                window titles and Win32 child controls only
====================  ==================================================

AppleScript itself stays unsupported and says so, so an action written
against it fails with a sentence the person can act on instead of a
traceback. ``platforms.blocked_actions`` keeps those actions out of the
model's catalogue in the first place.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import time
from pathlib import Path

from mcp_vision.buddy.actions.host import NotSupported, PortableHost, run
from mcp_vision.buddy.win32 import Win32Input, click_inputs, parse_combo, unicode_inputs, wheel_inputs

START_MENU_DIRS = (
    r"%ProgramData%\Microsoft\Windows\Start Menu\Programs",
    r"%AppData%\Microsoft\Windows\Start Menu\Programs",
)
WIN_SEARCH_ROOTS = ("Desktop", "Documents", "Downloads", "Pictures", "Videos", "Music")
TOAST_SCRIPT = r"""
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null
$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
    [Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$texts = $template.GetElementsByTagName('text')
$texts.Item(0).AppendChild($template.CreateTextNode($env:PLIP_TOAST_TITLE)) > $null
$texts.Item(1).AppendChild($template.CreateTextNode($env:PLIP_TOAST_BODY)) > $null
$toast = [Windows.UI.Notifications.ToastNotification]::new($template)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Plip').Show($toast)
"""


def powershell_path() -> str | None:
    return shutil.which("powershell") or shutil.which("pwsh")


class WindowsHost(PortableHost):
    """Everything actions need on Windows, with the gaps named out loud."""

    name = "windows"
    search_roots = WIN_SEARCH_ROOTS       # Videos, not Movies; no content search without Spotlight

    def __init__(self, home: str | None = None, *, input_api=None, powershell: str | None = None,
                 runner=run, startfile=None):
        super().__init__(home)
        self.input = Win32Input(input_api) if input_api is not None else Win32Input()
        self.powershell_exe = powershell if powershell is not None else powershell_path()
        self.run = runner
        self._startfile = startfile or getattr(os, "startfile", None)

    # -- apps & urls ---------------------------------------------------------------
    def list_apps(self) -> dict[str, str]:
        """Lower-cased Start Menu entry -> the shortcut Windows should open."""
        if self._apps is None:
            self._apps = {}
            for directory in START_MENU_DIRS:
                folder = Path(os.path.expandvars(directory))
                if "%" in str(folder) or not folder.is_dir():
                    continue
                for entry in folder.rglob("*.lnk"):
                    self._apps.setdefault(entry.stem.lower(), str(entry))
        return self._apps

    def open_app(self, path: str) -> None:
        self.open(path)

    def open(self, target: str) -> None:
        """A file, folder or URL, handed to whatever Windows has registered for it."""
        if self._startfile is None:
            raise NotSupported("Plip can't open things from this Python build.")
        self._startfile(target)

    def reveal(self, path: str) -> None:
        explorer = shutil.which("explorer") or "explorer"
        subprocess.Popen([explorer, f"/select,{os.path.normpath(path)}"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    # -- files ---------------------------------------------------------------------
    # -- system --------------------------------------------------------------------
    def osascript(self, script: str, timeout: float = 10.0) -> str:
        raise NotSupported("That one is written in AppleScript, which Windows doesn't have. "
                           "Ask me a different way, or do it in Windows Settings.")

    def powershell(self, script: str, timeout: float = 15.0, env: dict[str, str] | None = None) -> str:
        """Run a PowerShell snippet. Raises ``NotSupported`` when PowerShell isn't on PATH."""
        if not self.powershell_exe:
            raise NotSupported("PowerShell isn't on this machine's PATH, so Plip can't ask Windows to do that.")
        argv = [self.powershell_exe, "-NoProfile", "-NonInteractive", "-Command", script]
        merged = {**os.environ, **(env or {})} if env else None
        done = subprocess.run(argv, capture_output=True, text=True, timeout=timeout,
                              stdin=subprocess.DEVNULL, env=merged)
        if done.returncode != 0:
            raise RuntimeError((done.stderr or done.stdout or "PowerShell failed").strip()[:300])
        return done.stdout.strip()

    def notify(self, title: str, text: str) -> None:
        try:
            self.powershell(TOAST_SCRIPT, timeout=12.0,
                            env={"PLIP_TOAST_TITLE": title[:120], "PLIP_TOAST_BODY": text[:400]})
        except Exception:
            pass                        # a toast is never worth failing an action over

    def shortcuts(self) -> list[str]:
        raise NotSupported("Apple Shortcuts are macOS-only; Windows has no list for Plip to run.")

    def run_shortcut(self, name: str) -> str:
        raise NotSupported("Apple Shortcuts are macOS-only; Windows has no list for Plip to run.")

    # -- keyboard and mouse --------------------------------------------------------
    def type_text(self, text: str) -> None:
        """Type ``text`` into whatever has focus, character by character, any layout."""
        if not text:
            return
        self._send(unicode_inputs(text))

    def replace_selection(self, text: str) -> None:
        """Typing over a selection replaces it on Windows, so this is just typing."""
        self.type_text(text)

    def press(self, keys: str) -> None:
        """"cmd+t" style combos, translated to Windows (Command becomes Ctrl)."""
        self._send(parse_combo(keys).inputs())

    def click(self, x: float, y: float, button: str = "left", count: int = 1) -> None:
        self.hover(x, y)
        time.sleep(0.01)
        self._send(click_inputs(button, count))

    def hover(self, x: float, y: float) -> None:
        self._require_input()
        self.input.move(x, y)

    def scroll(self, x: float, y: float, dy: int, dx: int = 0) -> None:
        self.hover(x, y)
        self._send(wheel_inputs(dy, dx))

    def drag(self, x1: float, y1: float, x2: float, y2: float) -> None:
        from mcp_vision.buddy.win32 import (
            MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, mouse_input,
        )

        self.hover(x1, y1)
        self._send([mouse_input(MOUSEEVENTF_LEFTDOWN)])
        steps = 12
        for step in range(1, steps + 1):
            self.input.move(x1 + (x2 - x1) * step / steps, y1 + (y2 - y1) * step / steps)
            time.sleep(0.012)
        self._send([mouse_input(MOUSEEVENTF_LEFTUP)])

    def mouse_position(self) -> tuple[float, float] | None:
        return self.input.cursor()

    # -- grounding Plip does not have on Windows -----------------------------------
    # PortableHost already answers these with "don't know" (None / False / Reveal()),
    # which is the honest answer: there is no UI Automation reader yet. Listing them
    # here keeps the gap visible to anyone reading this file.
    def set_field(self, x: float, y: float, value: str) -> bool:
        raise NotSupported("Filling a field directly needs the macOS Accessibility API. "
                           "Plip can click it and type instead.")

    # -- internals -----------------------------------------------------------------
    def _require_input(self) -> None:
        if not self.input.available:
            raise NotSupported("Plip can't reach user32 from this Python, so it can't move the mouse "
                               "or type for you.")

    def _send(self, events) -> None:
        self._require_input()
        sent = self.input.send(events)
        if sent != len(events):
            raise RuntimeError("Windows refused some of those keystrokes. Another app may be blocking input.")


def default_windows_host() -> WindowsHost:
    return WindowsHost()


__all__ = ["START_MENU_DIRS", "WIN_SEARCH_ROOTS", "WindowsHost", "default_windows_host", "powershell_path"]
