"""A capturer that takes no pixels until someone says yes.

``ScreenCapturer`` is wrapped, not replaced, so the companion is unchanged:
it already treats an empty screenshot list as "couldn't see the screen" and
answers from the conversation instead. The gate turns that path into a
feature - the default for a learning session is no pixels at all.

``screens()`` still works while the gate is shut: it returns display
geometry (size and position), which the router needs to decide whether a
question even wants the screen, and which is not a picture of anything.
``capture``, ``glance`` and the two fingerprint calls are the ones that read
pixels, and they all go through ``allowed()``.

``denials`` counts what was refused, so the shell can say "screenshots are
off" where the answer would have had one rather than failing silently.
"""
from __future__ import annotations

from collections.abc import Callable
from typing import Any

from mcp_vision.buddy.geometry import Screenshot


class GatedCapturer:
    """Wraps a capturer; ``allowed()`` decides whether pixels may be read."""

    def __init__(self, inner: Any, allowed: Callable[[], bool],
                 reason: Callable[[], str] = lambda: "Screenshots are off for this session."):
        self.inner = inner
        self.allowed = allowed
        self.reason = reason
        self.denials = 0
        self.last_reason = ""

    # -- geometry: never a picture -------------------------------------------
    def screens(self):
        return self.inner.screens()

    def __getattr__(self, name):
        """Anything not gated here (max_edge, encode, from_images) is the inner one's."""
        return getattr(self.inner, name)

    # -- pixels ---------------------------------------------------------------
    def _deny(self) -> None:
        self.denials += 1
        self.last_reason = self.reason()

    def capture(self, *, only_cursor_screen: bool = False) -> list[Screenshot]:
        if not self.allowed():
            self._deny()
            return []
        return self.inner.capture(only_cursor_screen=only_cursor_screen)

    def glance(self):
        if not self.allowed():
            self._deny()
            return None
        return self.inner.glance()

    def fingerprint(self) -> bytes:
        if not self.allowed():
            self._deny()
            return b""
        return self.inner.fingerprint()

    def fingerprint_at(self, x: float, y: float, size: float = 300.0) -> bytes | None:
        if not self.allowed():
            self._deny()
            return None
        return self.inner.fingerprint_at(x, y, size)

    # -- for the shell --------------------------------------------------------
    def status(self) -> dict:
        return {"allowed": bool(self.allowed()), "denials": self.denials,
                "reason": "" if self.allowed() else self.reason()}


class GatedContext:
    """Same idea for the screen map: no window reading until it is switched on."""

    def __init__(self, inner: Any, allowed: Callable[[], bool]):
        self.inner = inner
        self.allowed = allowed
        self.denials = 0

    def __getattr__(self, name):
        return getattr(self.inner, name)

    def snapshot(self):
        from mcp_vision.buddy.screen_context import ScreenContext

        if not self.allowed():
            self.denials += 1
            return ScreenContext()
        return self.inner.snapshot()


__all__ = ["GatedCapturer", "GatedContext"]
