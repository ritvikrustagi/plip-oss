"""What Plip can honestly do on the machine it is running on.

One table, two readers: ``plip doctor`` prints it and the desktop shells grey
out what is missing with the reason next to it. Nothing here pretends: the
macOS rows name AppleScript, Spotlight, the notch and Apple Speech, and the
Windows rows name the native thing Plip uses instead (PowerShell, SendInput,
a top-centre strip window, a typed box) or say plainly that there is none.

``supported`` is the only field the UI should gate on. ``detail`` is what the
person reads, ``instead`` is the native alternative Plip actually uses, and
``evidence`` separates "we measured this" from "we assume this from the OS":
"probed" means Plip asked the system this run, "platform" means it follows
from the OS alone.
"""
from __future__ import annotations

import shutil
import sys
from dataclasses import dataclass, field, replace

MACOS = "macos"
WINDOWS = "windows"
OTHER = "other"


def current_platform(platform: str | None = None) -> str:
    """"macos", "windows", or "other" from a ``sys.platform`` string."""
    name = platform if platform is not None else sys.platform
    if name == "darwin":
        return MACOS
    if name in {"win32", "cygwin", "msys"}:
        return WINDOWS
    return OTHER


@dataclass(frozen=True)
class Capability:
    id: str
    label: str                       # what the person calls it
    supported: bool
    detail: str = ""                 # why, in one sentence they can act on
    instead: str = ""                # the native alternative Plip uses here
    evidence: str = "platform"       # platform | probed
    group: str = "general"

    def as_row(self) -> dict:
        return {"id": self.id, "label": self.label, "supported": self.supported, "detail": self.detail,
                "instead": self.instead, "evidence": self.evidence, "group": self.group}


# -- the table -------------------------------------------------------------------------
# One entry per capability per platform. Order is the order the UI shows them in.
_MAC = (
    Capability("chat", "Chat", True, "Ask in the notch island or by voice.", group="core"),
    Capability("walkthrough", "Walkthrough checklist", True, "Steps tick off as Plip works.", group="core"),
    Capability("screen_capture", "Screen capture", True, "Needs Screen Recording in System Settings.", group="eyes"),
    Capability("screen_context", "Screen map (grounding)", True,
               "The Accessibility tree names buttons, fields and the page text.", group="eyes"),
    Capability("push_to_talk", "Push-to-talk", True, "Hold the shortcut; needs Accessibility.", group="voice"),
    Capability("speech_in", "Speech recognition", True, "On-device Apple Speech, or AssemblyAI with a key.",
               group="voice"),
    Capability("speech_out", "Spoken answers", True, "macOS `say`, or ElevenLabs with a key.", group="voice"),
    Capability("typed_input", "Typed input", True, "Type into the island instead of holding the shortcut.",
               group="voice"),
    Capability("pointing", "Pointing at things", True, "Plip flies to the spot and labels it.", group="hands"),
    Capability("click", "Clicking and scrolling", True, "Quartz events; needs Accessibility.", group="hands"),
    Capability("type_text", "Typing for you", True, "Quartz events; needs Accessibility.", group="hands"),
    Capability("open_app", "Opening apps and links", True, "`open -a`.", group="hands"),
    Capability("file_search", "Finding files", True, "Spotlight (`mdfind`), newest first.", group="hands"),
    Capability("applescript", "AppleScript", True, "Dark mode, volume, Notes, Reminders.", group="system"),
    Capability("shortcuts", "Apple Shortcuts", True, "Runs the shortcuts you already have.", group="system"),
    Capability("notifications", "Notifications", True, "`display notification`.", group="system"),
    Capability("notch_island", "Notch island", True, "A transparent window around the notch.", group="shell"),
    Capability("mascot", "Plip by your cursor", True, "A floating WebKit mascot.", group="shell"),
    Capability("web_settings", "Settings window", True, "The React dashboard in a WKWebView.", group="shell"),
    Capability("local_memory", "Local memory", True, "What you tell Plip, on this machine only.", group="data"),
    Capability("learning_events", "Learning-event export", True,
               "Opt-in session events as JSON Lines you can read, export or delete.", group="data"),
)

_WINDOWS = (
    Capability("chat", "Chat", True, "Ask in the strip at the top of the screen.", group="core"),
    Capability("walkthrough", "Walkthrough checklist", True, "Steps tick off as Plip works.", group="core"),
    Capability("screen_capture", "Screen capture", True,
               "Off until you switch it on for the session; no screenshot leaves this machine unless you share it.",
               instead="mss (Desktop Duplication / GDI)", group="eyes"),
    Capability("screen_context", "Screen map (grounding)", True,
               "Window titles and visible Win32 controls only. Browser, Electron and UWP windows read as blind, "
               "and Plip never reads the text inside a box you type in.",
               instead="user32 window enumeration (no UI Automation yet)", group="eyes"),
    Capability("push_to_talk", "Push-to-talk", True,
               "Hold Ctrl+Alt. Plip polls the four modifier keys only, so it cannot see what you type.",
               instead="GetAsyncKeyState polling, no keyboard hook", group="voice"),
    Capability("speech_in", "Speech recognition", False,
               "No on-device engine ships for Windows yet. Add an AssemblyAI key to talk, or type instead.",
               instead="typed input in the strip", group="voice"),
    Capability("speech_out", "Spoken answers", True, "Windows' own voice.",
               instead="SAPI via System.Speech (PowerShell)", group="voice"),
    Capability("typed_input", "Typed input", True, "The supported way in until speech is set up.", group="voice"),
    Capability("pointing", "Pointing at things", False,
               "The click-through mascot overlay is macOS-only for now; Plip tells you the spot instead.",
               instead="the strip names the target and its coordinates", group="hands"),
    Capability("click", "Clicking and scrolling", True, "Risky clicks still ask first.",
               instead="user32 SendInput", group="hands"),
    Capability("type_text", "Typing for you", True, "Unicode keystrokes into the focused box.",
               instead="user32 SendInput (KEYEVENTF_UNICODE)", group="hands"),
    Capability("open_app", "Opening apps and links", True, "Start Menu shortcuts and the default browser.",
               instead="os.startfile / explorer", group="hands"),
    Capability("file_search", "Finding files", True,
               "Walks your user folders. Slower than Spotlight and it does not search inside files.",
               instead="filename walk of Desktop/Documents/Downloads/Pictures/Videos/Music", group="hands"),
    Capability("applescript", "AppleScript", False,
               "AppleScript does not exist on Windows. Plip runs PowerShell for the few things it needs.",
               instead="PowerShell (dark mode, notifications, voice)", group="system"),
    Capability("shortcuts", "Apple Shortcuts", False, "There is no Windows equivalent Plip can drive yet.",
               group="system"),
    Capability("notifications", "Notifications", True, "A Windows toast.",
               instead="Windows.UI.Notifications via PowerShell", group="system"),
    Capability("notch_island", "Notch island", False,
               "Windows laptops have no notch and no AppKit. Plip uses a strip pinned to the top of your screen.",
               instead="a top-centre always-on-top window", group="shell"),
    Capability("mascot", "Plip by your cursor", False, "The floating mascot needs AppKit and WebKit.",
               group="shell"),
    Capability("web_settings", "Settings window", False,
               "The React dashboard needs WKWebView. The Windows shell shows the same controls in plain widgets.",
               instead="the shell's own panel", group="shell"),
    Capability("local_memory", "Local memory", True, "What you tell Plip, on this machine only.", group="data"),
    Capability("learning_events", "Learning-event export", True,
               "Opt-in session events as JSON Lines you can read, export or delete.", group="data"),
)

_UNSUPPORTED_ELSEWHERE = {"push_to_talk", "speech_in", "pointing", "click", "type_text", "applescript", "shortcuts",
                          "notch_island", "mascot", "web_settings", "screen_context"}


def _other_table() -> tuple[Capability, ...]:
    """Linux and anything else: the headless surface (`plip ask`) plus the data tools."""
    rows = []
    for cap in _MAC:
        if cap.id in _UNSUPPORTED_ELSEWHERE:
            rows.append(replace(cap, supported=False, instead="",
                                detail="Desktop control is macOS and Windows only; `plip ask --image` works here."))
        else:
            rows.append(replace(cap, instead="", detail=""))
    return tuple(rows)


_TABLES = {MACOS: _MAC, WINDOWS: _WINDOWS}


@dataclass(frozen=True)
class Capabilities:
    platform: str
    rows: tuple[Capability, ...] = field(default_factory=tuple)

    def __getitem__(self, cap_id: str) -> Capability:
        for row in self.rows:
            if row.id == cap_id:
                return row
        raise KeyError(cap_id)

    def get(self, cap_id: str) -> Capability | None:
        try:
            return self[cap_id]
        except KeyError:
            return None

    def supports(self, cap_id: str) -> bool:
        row = self.get(cap_id)
        return bool(row and row.supported)

    def why_not(self, cap_id: str) -> str:
        """The sentence to show beside a greyed-out control ("" when it works)."""
        row = self.get(cap_id)
        if row is None:
            return f"Plip doesn't know about {cap_id} on {self.platform}."
        return "" if row.supported else (row.detail or f"{row.label} isn't available on {self.platform}.")

    def groups(self) -> list[tuple[str, list[Capability]]]:
        order: list[str] = []
        by_group: dict[str, list[Capability]] = {}
        for row in self.rows:
            if row.group not in by_group:
                order.append(row.group)
                by_group[row.group] = []
            by_group[row.group].append(row)
        return [(name, by_group[name]) for name in order]

    def as_rows(self) -> list[dict]:
        return [row.as_row() for row in self.rows]


def capabilities(platform: str | None = None, *, probe: bool = False) -> Capabilities:
    """The table for a platform. ``probe=True`` asks this machine the cheap questions."""
    name = current_platform(platform)
    rows = _TABLES.get(name) or _other_table()
    if probe:
        rows = tuple(_probed(row, name) for row in rows)
    return Capabilities(name, rows)


def _probed(cap: Capability, platform: str) -> Capability:
    """Replace a platform assumption with something Plip actually checked."""
    if cap.id == "speech_in" and platform == WINDOWS:
        import os

        if os.environ.get("ASSEMBLYAI_API_KEY"):
            return replace(cap, supported=True, evidence="probed",
                           detail="Streaming through AssemblyAI with the key in your environment.",
                           instead="AssemblyAI streaming v3")
        return replace(cap, evidence="probed")
    if cap.id == "speech_out" and platform == WINDOWS:
        if _powershell() is None:
            return replace(cap, supported=False, evidence="probed",
                           detail="PowerShell isn't on PATH, so Plip can't reach the Windows voice. "
                                  "Answers stay on screen.", instead="")
        return replace(cap, evidence="probed")
    if cap.id in {"push_to_talk", "click", "type_text", "screen_context"} and platform == WINDOWS:
        if not _has_user32():
            return replace(cap, supported=False, evidence="probed",
                           detail="user32 isn't reachable from this Python, so Plip can't send input.", instead="")
        return replace(cap, evidence="probed")
    if cap.id == "speech_out" and platform == MACOS:
        return replace(cap, evidence="probed", supported=bool(shutil.which("say")) or cap.supported)
    if cap.id in {"applescript", "shortcuts"} and platform == MACOS:
        return replace(cap, evidence="probed", supported=bool(shutil.which("osascript")))
    if cap.id == "file_search" and platform == MACOS:
        return replace(cap, evidence="probed", supported=True,
                       detail=cap.detail if shutil.which("mdfind") else "Spotlight is off; Plip walks your folders.")
    return cap


def _powershell() -> str | None:
    return shutil.which("powershell") or shutil.which("pwsh")


def _has_user32() -> bool:
    import ctypes

    try:
        return getattr(ctypes, "windll", None) is not None and bool(ctypes.windll.user32)   # type: ignore[attr-defined]
    except Exception:
        return False


# -- actions ---------------------------------------------------------------------------
# Action names from buddy/actions that cannot work on a platform, with the sentence the
# model and the person both get back. The engine refuses them before they run, and leaves
# them out of the catalogue so the model stops offering them.
_WINDOWS_BLOCKED = {
    "system": "Dark mode, volume and display sleep go through AppleScript, which Windows doesn't have. "
              "Use Windows Settings or the tray.",
    "run_shortcut": "Apple Shortcuts are macOS-only; there's no Windows equivalent Plip can run.",
    "list_shortcuts": "Apple Shortcuts are macOS-only; there's no Windows equivalent Plip can run.",
    "create_note": "Plip writes to Apple Notes, which Windows doesn't have.",
    "create_reminder": "Plip writes to Apple Reminders, which Windows doesn't have.",
    "read_page": "Reading the whole page needs the macOS Accessibility API. Plip can still look at the screen "
                 "if you switch screenshots on.",
    "scroll_to": "Scrolling something into view needs the macOS Accessibility API. Ask Plip to scroll instead.",
}


def blocked_actions(platform: str | None = None) -> dict[str, str]:
    """Action name -> why it can't run here. Empty on macOS."""
    return dict(_WINDOWS_BLOCKED) if current_platform(platform) == WINDOWS else {}


def action_guard(platform: str | None = None):
    """``(name) -> reason`` for ``ActionEngine(unsupported=...)``; "" means go ahead."""
    blocked = blocked_actions(platform)
    return lambda name: blocked.get(name, "")


__all__ = ["MACOS", "OTHER", "WINDOWS", "Capabilities", "Capability", "action_guard", "blocked_actions",
           "capabilities", "current_platform"]
