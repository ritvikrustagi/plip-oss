"""The Windows shell's brain: everything but the widgets.

``WindowsShell`` is the counterpart of the wiring inside ``app_macos.py``,
with the AppKit parts taken out so it can be built and driven in a test. It
owns the asyncio loop, the companion, the push-to-talk controller, the
presenter, the ``ShellView`` the window draws, the capability table and the
learning session.

What it keeps from the macOS app, unchanged:

* the companion, so chat, routing, the walkthrough checklist and the
  ``[DO:...]`` actions behave the same;
* ``ActionEngine``'s confirm-before-you-act rule - a consequential action
  still stops at a card and waits for ``confirm(True)``;
* ``Memory``, ``History`` and ``UsageLog`` on this machine only.

What it does differently, because Windows is not a Mac:

* the strip replaces the notch island and there is no mascot;
* push-to-talk polls four modifier keys instead of tapping the event stream,
  and typing in the box is a first-class way in, not a fallback bolted on;
* screenshots and the window map are off until the session says otherwise;
* unsupported actions are listed with their reasons in ``view.controls()``.
"""
from __future__ import annotations

import asyncio
import threading
from collections.abc import Callable
from typing import Any

from mcp_vision.buddy.controller import BuddyController
from mcp_vision.buddy.gated_capture import GatedCapturer, GatedContext
from mcp_vision.buddy.hotkey import ChordDetector, chord
from mcp_vision.buddy.presenter import Presenter
from mcp_vision.buddy.shell_view import ShellView
from mcp_vision.learning.consent import SessionConsent
from mcp_vision.learning.session import LearningSession
from mcp_vision.log import get_logger
from mcp_vision.platforms import capabilities

log = get_logger("mcp_vision.buddy.windows")


class _Strip:
    """Stands in for the mascot: the controller wants somewhere to put its state."""

    def __init__(self, view: ShellView):
        self.view = view
        self.state = "idle"

    def set_state(self, state: str) -> None:
        self.state = state

    def set_level(self, level: float) -> None:
        pass


class WindowsShell:
    """Build with ``WindowsShell.build()``; the window then calls into it."""

    def __init__(self, *, settings, prefs, loop: asyncio.AbstractEventLoop,
                 on_main: Callable[[Callable[[], None]], None] | None = None,
                 caps=None, consent: SessionConsent | None = None,
                 learning: LearningSession | None = None, history=None, memory=None, usage=None,
                 call_later: Callable[[float, Callable[[], None]], Any] | None = None):
        self.settings = settings
        self.prefs = prefs
        self.loop = loop
        self.on_main = on_main or (lambda job: job())
        self.caps = caps if caps is not None else capabilities(probe=True)
        self.consent = consent if consent is not None else SessionConsent.load()
        self.learning = learning if learning is not None else LearningSession(consent=self.consent,
                                                                             platform="windows")
        self.history = history
        self.memory = memory
        self.usage = usage
        self.view = ShellView(capabilities=self.caps, consent=self.consent)
        self.strip = _Strip(self.view)
        self.presenter = Presenter(post_island=lambda messages: self.on_main(lambda: self.view.post(messages)))
        self.capturer: GatedCapturer | None = None
        self.setup_error = ""
        self._call_later = call_later or self._thread_timer
        self.controller = BuddyController(
            companion=None, overlay=self.strip, loop=loop, presenter=self.presenter,
            call_later=self._call_later, on_main=lambda fn, *args: self.on_main(lambda: fn(*args)),
            on_result=self._recorded, say=lambda text: None,
            setup_error="Plip is still waking up. Try again in a second.",
            press_delay=BuddyController.PRESS_DELAY,
        )
        self.controller.shortcut, self.controller.shortcut_keys = "Ctrl+Alt", "Ctrl+Alt"
        self.detector = ChordDetector(on_press=self.controller.on_press, on_release=self.controller.on_release,
                                      on_cancel=self.controller.on_cancel, chord=chord(prefs.hotkey).mask)
        self.hotkeys: Any = None

    # -- construction ---------------------------------------------------------
    @classmethod
    def build(cls, *, on_main=None, probe: bool = True, start_hotkeys: bool = True) -> WindowsShell:
        from mcp_vision.buddy.factory import apply_prefs
        from mcp_vision.buddy.memory import Memory
        from mcp_vision.buddy.settings import load_settings
        from mcp_vision.buddy.store import History, Prefs
        from mcp_vision.buddy.usage import UsageLog

        prefs = Prefs.load()
        settings = apply_prefs(load_settings(), prefs)
        loop = asyncio.new_event_loop()
        from mcp_vision.buddy import workers

        workers.install(loop)
        threading.Thread(target=loop.run_forever, daemon=True, name="plip-loop").start()
        shell = cls(settings=settings, prefs=prefs, loop=loop, on_main=on_main,
                    history=History(), memory=Memory(), usage=UsageLog())
        shell.rebuild(probe=probe)
        if start_hotkeys:
            shell.start_hotkeys()
        return shell

    def start_hotkeys(self, listener=None) -> str:
        from mcp_vision.buddy.hotkey_windows import WindowsHotkeyListener, describe

        self.hotkeys = listener or WindowsHotkeyListener(self.detector, on_main=self.on_main)
        mode = self.hotkeys.start()
        self.controller.hotkey_mode = mode
        card = describe(self.prefs.hotkey)
        self.controller.shortcut = card["label"]
        self.controller.shortcut_keys = card["label"]
        self.view.post([{"type": "shortcut", "state": {**card, "works": mode != "none"}}])
        return mode

    # -- the companion --------------------------------------------------------
    def rebuild(self, probe: bool = True, *, engines: list | None = None) -> str:
        """Assemble the companion for the current settings. Returns "" or the problem."""
        from mcp_vision.buddy.capture import ScreenCapturer
        from mcp_vision.buddy.factory import SetupError, make_companion, make_context
        from mcp_vision.buddy.speech_in import ListenerCallbacks, make_listener

        raw = ScreenCapturer(max_edge=self.settings.max_image_edge, quality=self.settings.jpeg_quality)
        self.capturer = GatedCapturer(raw, allowed=lambda: self.consent.allows("screenshots"),
                                      reason=lambda: self.consent.why_not("screenshots"))
        inner_context = make_context(self.settings)
        context = (GatedContext(inner_context, allowed=lambda: self.consent.allows("screen_context"))
                   if inner_context is not None else None)
        try:
            companion = make_companion(self.settings, pointer=None, observer=self.presenter, prefs=self.prefs,
                                       engines=engines, watch=False, memory=self.memory, usage=self.usage,
                                       capturer=self.capturer, context=context)
            self.setup_error = ""
        except SetupError as exc:
            companion, self.setup_error = None, str(exc)
        except Exception as exc:                      # a broken optional piece must not kill the shell
            log.exception("could not build Plip's brain on Windows")
            companion, self.setup_error = None, f"Couldn't start the brain: {exc}"
        self.controller.companion = companion
        try:
            self.controller.listener = make_listener(self.settings, ListenerCallbacks(
                partial=lambda text: self.on_main(lambda: self.controller.on_partial(text)),
                final=lambda text: self.on_main(lambda: self.controller.on_final(text)),
                level=lambda value: self.on_main(lambda: self.controller.on_level(value)),
                error=lambda message: self.on_main(lambda: self.controller.on_error(message))))
        except RuntimeError as exc:
            # No speech engine here: typing stays the supported way in, and the strip says so.
            self.controller.listener = None
            self.view.notice(str(exc))
        self.controller.setup_error = self.setup_error
        if self.setup_error:
            self.view.notice(self.setup_error)
        return self.setup_error

    # -- what the window calls ------------------------------------------------
    def ask(self, text: str) -> None:
        """Send a typed question. The supported way in when speech isn't set up."""
        text = " ".join((text or "").split())
        if not text:
            return
        self.controller.ask(text)

    def stop(self) -> None:
        self.controller.stop()

    def confirm(self, accept: bool) -> None:
        """Answer the safety card. Nothing consequential runs without this."""
        companion = self.controller.companion
        if companion is None:
            return
        asyncio.run_coroutine_threadsafe(companion.answer_pending(bool(accept)), self.loop)

    def offer(self, accept: bool) -> None:
        companion = self.controller.companion
        if accept:
            self.controller.ask("yes")
        else:
            if companion is not None:
                self.loop.call_soon_threadsafe(companion.decline)
            self.presenter.idle()

    def clear(self) -> None:
        companion = self.controller.companion
        if companion is not None:
            companion.conversation.clear()
        self.view.notice("Conversation cleared.")

    # -- the learning session -------------------------------------------------
    def start_session(self, **options) -> None:
        """Begin recording learning events. Needs an explicit grant; see SessionConsent."""
        self.learning.start(**options)
        self.view.consent = self.consent = self.learning.consent
        self.view.notice(f"Session started. {self.consent.summary()}")

    def pause_session(self) -> None:
        self.learning.pause()
        self.view.notice("Session paused: no events, no screenshots, no window map.")

    def resume_session(self) -> None:
        self.learning.resume()
        self.view.notice("Session resumed.")

    def stop_session(self) -> None:
        self.learning.stop()
        self.view.notice("Session stopped. Nothing is being recorded.")

    def toggle(self, switch: str) -> None:
        try:
            self.learning.set(switch, not getattr(self.consent, switch))
        except ValueError as exc:
            self.view.notice(str(exc))
            return
        state = "on" if getattr(self.consent, switch) else "off"
        self.view.notice(f"{switch.replace('_', ' ')} is now {state}.")

    def export_learning(self) -> str:
        return self.learning.export()

    def forget_learning(self) -> int:
        gone = self.learning.forget_everything()
        self.view.consent = self.consent = self.learning.consent
        self.view.notice(f"Deleted {gone} learning event(s), the session record and the local id.")
        return gone

    # -- internals ------------------------------------------------------------
    def _recorded(self, transcript: str, result) -> None:
        if self.history is not None and result.state == "done" and result.spoken:
            brain = getattr(self.controller.companion, "brain", None)
            self.history.add(transcript, result.spoken, engine=getattr(brain, "label", ""))

    def _thread_timer(self, delay: float, fn: Callable[[], None]):
        timer = threading.Timer(delay, lambda: self.on_main(fn))
        timer.daemon = True
        timer.start()
        return timer

    def shutdown(self) -> None:
        if self.hotkeys is not None:
            self.hotkeys.stop()
        companion = self.controller.companion
        closing = getattr(getattr(companion, "brain", None), "close", None)
        if closing is not None:
            try:
                closing()
            except Exception:
                pass
        self.loop.call_soon_threadsafe(self.loop.stop)


__all__ = ["WindowsShell"]
