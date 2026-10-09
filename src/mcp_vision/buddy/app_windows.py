"""Plip on Windows: a strip at the top of the screen, drawn with Tkinter.

Windows has no notch and no AppKit, so the island becomes a borderless,
always-on-top window pinned to the top centre of the primary display - the
same job, done with what the OS has. Tkinter is deliberate: it ships with
CPython on Windows, so a ``pip install`` is enough to get a window and no
native build step stands between a student and a running Plip. The React
dashboard stays macOS-only for now (it needs WKWebView); the controls it
holds appear here as plain rows, each one greyed out with its reason when
this machine can't do it.

The window is a thin renderer over ``ShellView``: it draws ``view.render()``
and sends clicks back to ``WindowsShell``. ``run_windows_app(headless=True)``
runs the same shell with no window at all, which is how the shell is smoke
tested where no display exists.
"""
from __future__ import annotations

import queue
import threading
from typing import Any

from mcp_vision.log import get_logger

log = get_logger("mcp_vision.buddy.windows")

STRIP_WIDTH = 760
STRIP_HEIGHT = 420
BG = "#111318"
FG = "#eef1f6"
DIM = "#8d94a3"
ACCENT = "#6ea8fe"
WARN = "#f0a55c"


def tkinter_available() -> tuple[bool, str]:
    """Whether a window can be opened here, and why not when it can't."""
    try:
        import tkinter  # noqa: F401
    except ImportError as exc:
        return False, (f"Tkinter isn't in this Python ({exc}). On Windows it comes with the python.org "
                       "installer; reinstall Python with the tcl/tk option, or run `plip windows --headless`.")
    return True, ""


class StripWindow:
    """The always-on-top strip. Every widget reads from ``shell.view``."""

    def __init__(self, shell: Any):
        import tkinter as tk

        self.shell = shell
        self.tk = tk
        self.jobs: queue.Queue = queue.Queue()
        root = tk.Tk()
        self.root = root
        root.title("Plip")
        root.configure(bg=BG)
        root.attributes("-topmost", True)
        try:
            root.overrideredirect(False)            # keep the title bar: a student needs to move it
        except tk.TclError:
            pass
        width = root.winfo_screenwidth()
        root.geometry(f"{STRIP_WIDTH}x{STRIP_HEIGHT}+{max(0, (width - STRIP_WIDTH) // 2)}+24")

        self._style()
        self.status = tk.Label(root, text="Starting…", bg=BG, fg=ACCENT, anchor="w",
                               font=("Segoe UI Semibold", 11))
        self.status.pack(fill="x", padx=14, pady=(12, 4))

        self.body = tk.Text(root, height=12, bg="#171a21", fg=FG, bd=0, wrap="word", padx=10, pady=8,
                            font=("Segoe UI", 10), insertbackground=FG)
        self.body.pack(fill="both", expand=True, padx=14)
        self.body.configure(state="disabled")

        entry_row = tk.Frame(root, bg=BG)
        entry_row.pack(fill="x", padx=14, pady=8)
        self.entry = tk.Entry(entry_row, bg="#1d212a", fg=FG, bd=0, insertbackground=FG, font=("Segoe UI", 11))
        self.entry.pack(side="left", fill="x", expand=True, ipady=6)
        self.entry.bind("<Return>", lambda _event: self.send())
        from tkinter import ttk

        self.send_button = ttk.Button(entry_row, text="Ask", command=self.send)
        self.send_button.pack(side="left", padx=(8, 0))

        self.buttons = tk.Frame(root, bg=BG)
        self.buttons.pack(fill="x", padx=14, pady=(0, 12))
        self._button("Stop", lambda: shell.stop())
        self.yes_button = self._button("Yes, do it", lambda: shell.confirm(True))
        self.no_button = self._button("No", lambda: shell.confirm(False))
        self._button("Session…", self.session_window)
        self._button("Clear", lambda: shell.clear())

        shell.view.on_change = self.schedule_redraw
        root.protocol("WM_DELETE_WINDOW", self.close)
        root.after(120, self._drain)
        self.redraw()

    def _style(self) -> None:
        """Dark buttons where the theme engine allows it; never at the cost of the label."""
        from tkinter import ttk

        style = ttk.Style(self.root)
        try:
            style.theme_use("clam")               # the one theme that honours colours everywhere
        except Exception:
            return
        style.configure("TButton", background="#232833", foreground=FG, borderwidth=0, padding=(10, 4),
                        font=("Segoe UI", 9))
        style.map("TButton", background=[("active", "#2e3440"), ("disabled", "#191c23")],
                  foreground=[("disabled", DIM)])
        style.configure("Danger.TButton", background="#3a2328", foreground=FG, borderwidth=0,
                        padding=(10, 4), font=("Segoe UI", 9))

    def _button(self, label: str, command, parent=None, danger: bool = False):
        """``ttk`` on purpose: a plain ``tk.Button`` drops ``bg``/``fg`` on some platforms
        and the label disappears into the background. ttk always draws its text."""
        from tkinter import ttk

        button = ttk.Button(parent if parent is not None else self.buttons, text=label, command=command,
                            style="Danger.TButton" if danger else "TButton")
        button.pack(side="left", padx=(0, 6))
        return button

    # -- main-thread plumbing -------------------------------------------------
    def call_on_main(self, job) -> None:
        """Anything from a worker thread lands here and runs in ``_drain``."""
        self.jobs.put(job)

    def _drain(self) -> None:
        while True:
            try:
                job = self.jobs.get_nowait()
            except queue.Empty:
                break
            try:
                job()
            except Exception:
                log.exception("a Plip UI job failed")
        self.root.after(60, self._drain)

    def schedule_redraw(self) -> None:
        self.jobs.put(self.redraw)

    # -- drawing --------------------------------------------------------------
    def redraw(self) -> None:
        view = self.shell.view.render()
        self.status.configure(text=view["status"], fg=WARN if view["phase"] == "error" else ACCENT)
        self.body.configure(state="normal")
        self.body.delete("1.0", "end")
        # Line 0 is the status, which the header above already shows.
        self.body.insert("end", "\n".join(self.shell.view.lines()[1:]))
        self.body.configure(state="disabled")
        has_card = view["confirm"] is not None
        for button, on in ((self.yes_button, has_card), (self.no_button, has_card)):
            button.configure(state="normal" if on else "disabled")
        if has_card:
            self.yes_button.configure(text=view["confirm"]["confirm"])
        talk = next((row for row in view["controls"] if row["id"] == "ask"), None)
        enabled = bool(talk and talk["enabled"])
        self.send_button.configure(state="normal" if enabled else "disabled")

    def send(self) -> None:
        text = self.entry.get()
        self.entry.delete(0, "end")
        self.shell.ask(text)

    # -- the session panel ----------------------------------------------------
    def session_window(self) -> None:
        """Start/pause/stop, the three data switches, export and delete - all in one place."""
        tk = self.tk
        panel = tk.Toplevel(self.root, bg=BG)
        panel.title("Plip - this learning session")
        panel.attributes("-topmost", True)
        line = tk.Label(panel, text=self.shell.consent.summary(), bg=BG, fg=FG, anchor="w",
                        font=("Segoe UI Semibold", 10), wraplength=460, justify="left")
        line.pack(fill="x", padx=14, pady=(12, 8))

        def refresh() -> None:
            line.configure(text=self.shell.consent.summary())
            for row, widgets in rows.items():
                state = self.shell.consent
                widgets["var"].set(bool(getattr(state, row)))
                reason = state.why_not(row)
                widgets["check"].configure(state="normal" if not reason else "disabled")
                widgets["note"].configure(text=reason or widgets["detail"])
            self.schedule_redraw()

        actions = tk.Frame(panel, bg=BG)
        actions.pack(fill="x", padx=14)
        for label, job in (("Start session", lambda: (self.shell.start_session(granted_by="student"), refresh())),
                           ("Pause", lambda: (self.shell.pause_session(), refresh())),
                           ("Resume", lambda: (self.shell.resume_session(), refresh())),
                           ("Stop", lambda: (self.shell.stop_session(), refresh()))):
            self._button(label, job, parent=actions)

        rows: dict[str, dict] = {}
        for row in self.shell.consent.as_rows():
            holder = tk.Frame(panel, bg=BG)
            holder.pack(fill="x", padx=14, pady=(10, 0))
            var = tk.BooleanVar(value=row["on"])

            def flip(name=row["id"]):
                self.shell.toggle(name)
                refresh()

            check = tk.Checkbutton(holder, text=row["label"], variable=var, command=flip, bg=BG, fg=FG,
                                   selectcolor="#1d212a", activebackground=BG, activeforeground=FG,
                                   anchor="w", font=("Segoe UI", 10))
            check.pack(fill="x")
            note = tk.Label(holder, text=row["detail"], bg=BG, fg=DIM, anchor="w", wraplength=460,
                            justify="left", font=("Segoe UI", 8))
            note.pack(fill="x", padx=(24, 0))
            rows[row["id"]] = {"var": var, "check": check, "note": note, "detail": row["detail"]}

        data = tk.Frame(panel, bg=BG)
        data.pack(fill="x", padx=14, pady=12)
        self._button("Export my data", self.export, parent=data)
        self._button("Delete everything", lambda: (self.shell.forget_learning(), refresh()),
                     parent=data, danger=True)

        unavailable = [row for row in self.shell.view.controls() if not row["enabled"]]
        if unavailable:
            tk.Label(panel, text="Not available on this machine", bg=BG, fg=DIM, anchor="w",
                     font=("Segoe UI Semibold", 9)).pack(fill="x", padx=14)
            for row in unavailable:
                tk.Label(panel, text=f"• {row['label']} — {row['reason']}", bg=BG, fg=DIM, anchor="w",
                         wraplength=460, justify="left", font=("Segoe UI", 8)).pack(fill="x", padx=(24, 14))
        refresh()

    def export(self) -> None:
        from pathlib import Path

        text = self.shell.export_learning()
        target = Path.home() / "plip-learning-export.jsonl"
        target.write_text(text, encoding="utf-8")
        self.shell.view.notice(f"Exported {len(text.splitlines())} event(s) to {target}")

    def close(self) -> None:
        self.shell.shutdown()
        self.root.destroy()

    def run(self) -> None:
        self.root.mainloop()


def run_headless(shell: Any, *, prints=print, once: bool = False) -> None:
    """No window: print the strip, then wait (or exit, with ``once``, for a CI smoke run)."""
    for line in shell.view.lines():
        prints(line)
    prints("")
    for group, rows in shell.caps.groups():
        for row in rows:
            if not row.supported:
                prints(f"  (off) {row.label}: {row.detail}")
    if once:
        shell.shutdown()
        return
    prints("Plip is running without a window. Ctrl+C to stop.")
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        pass
    finally:
        shell.shutdown()


def run_windows_app(*, headless: bool = False, probe: bool = True, once: bool = False) -> None:
    """Start Plip's Windows shell. Raises ``RuntimeError`` with the reason if it can't."""
    from mcp_vision.buddy.shell_windows import WindowsShell
    from mcp_vision.platforms import capabilities, current_platform

    if current_platform() not in {"windows", "other"} and not headless:
        raise RuntimeError("The Windows shell is for Windows. On a Mac run `plip` for the notch app.")
    if headless:
        shell = WindowsShell.build(probe=probe, start_hotkeys=False)
        run_headless(shell, once=once)
        return
    ok, why = tkinter_available()
    if not ok:
        raise RuntimeError(why)
    holder: dict[str, Any] = {}
    shell = WindowsShell.build(on_main=lambda job: holder["window"].call_on_main(job)
                               if "window" in holder else job(), probe=probe, start_hotkeys=False)
    window = StripWindow(shell)
    holder["window"] = window
    mode = shell.start_hotkeys()
    caps = capabilities(probe=True)
    if mode == "none":
        shell.view.notice("Push-to-talk is off: " + (caps.why_not("push_to_talk")
                                                     or "Plip can't reach user32 on this machine."))
    if not caps.supports("speech_in"):
        shell.view.notice("Type your question in the box: " + caps.why_not("speech_in"))
    shell.view.notice("Screenshots and the window map stay off until you switch them on in Session…")
    window.run()


__all__ = ["StripWindow", "run_headless", "run_windows_app", "tkinter_available"]
