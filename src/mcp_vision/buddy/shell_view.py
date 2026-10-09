"""The Windows shell's state, with no widgets in it.

``Presenter`` already speaks a platform-neutral language: lists of bridge
messages (``island``, ``step``, ``append``, ``reset``, ``shortcut``) that the
macOS side pours into a WKWebView. ``ShellView`` consumes the same messages
and keeps them as plain data, so the Windows window is a thin renderer and
the interesting part - what the strip says, which checklist steps are ticked,
whether the confirm card is up, which controls are greyed out and why - is
testable on any machine.

``render()`` returns the text blocks a widget toolkit needs. ``lines()`` is
the same thing as plain text, which is what the tests read and what
``plip windows --headless`` prints.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

STATUS_MARKS = {"active": "…", "done": "✓", "skipped": "–", "failed": "✗", "error": "✗"}
PHASE_WORDS = {"idle": "Ready", "listening": "Listening", "thinking": "Thinking",
               "answering": "Answering", "error": "Problem"}


def _blank_island() -> dict[str, Any]:
    return {"phase": "idle", "level": 0.0, "transcript": "", "answer": "", "done": False, "speaking": False,
            "finished": None, "offer": None, "error": "", "fixable": False, "latencyMs": None,
            "walkthrough": None, "engine": None, "plan": [], "planIndex": 0, "confirm": None, "results": []}


@dataclass
class ShellView:
    """Fold bridge messages into something a window can draw."""

    island: dict[str, Any] = field(default_factory=_blank_island)
    steps: list[dict[str, Any]] = field(default_factory=list)
    shortcut: dict[str, Any] = field(default_factory=dict)
    on_change: Callable[[], None] = lambda: None
    capabilities: Any = None                  # platforms.Capabilities, for the greyed-out reasons
    consent: Any = None                       # learning.SessionConsent, same
    notices: list[str] = field(default_factory=list)

    # -- incoming ------------------------------------------------------------
    def post(self, messages: list[dict[str, Any]]) -> None:
        for message in messages or []:
            self._one(message)
        self._changed()

    def _one(self, message: dict[str, Any]) -> None:
        kind = message.get("type")
        if kind == "reset":
            self.island = _blank_island()
            self.steps = []
        elif kind == "island":
            for key, value in (message.get("state") or {}).items():
                self.island[key] = value
        elif kind == "step":
            self._step(message.get("step") or {})
        elif kind == "append":
            field_name = str(message.get("field") or "answer")
            self.island[field_name] = str(self.island.get(field_name) or "") + str(message.get("text") or "")
        elif kind == "shortcut":
            self.shortcut = dict(message.get("state") or {})

    def _step(self, step: dict[str, Any]) -> None:
        if not step.get("id"):
            return
        for index, existing in enumerate(self.steps):
            if existing.get("id") == step["id"]:
                self.steps[index] = {**existing, **step}
                return
        self.steps.append(dict(step))

    def _changed(self) -> None:
        try:
            self.on_change()
        except Exception:
            pass

    def notice(self, text: str) -> None:
        """A shell-side message (consent changed, a capability is missing)."""
        if text:
            self.notices = ([*self.notices, text])[-5:]
            self._changed()

    # -- outgoing ------------------------------------------------------------
    @property
    def phase(self) -> str:
        return str(self.island.get("phase") or "idle")

    def status_line(self) -> str:
        island = self.island
        if island.get("error"):
            return f"Problem: {island['error']}"
        word = PHASE_WORDS.get(self.phase, self.phase)
        walkthrough = island.get("walkthrough")
        if walkthrough:
            word += f" · step {int(walkthrough.get('index', 0)) + 1} of {walkthrough.get('total', 1)}"
        if island.get("done") and island.get("latencyMs"):
            word += f" · {int(island['latencyMs']) / 1000:.1f}s"
        engine = island.get("engine") or {}
        if engine.get("label"):
            word += f" · {engine['label']}"
        return word

    def checklist(self) -> list[str]:
        """The walkthrough, as the strip shows it: plan steps then live steps."""
        out = []
        plan = list(self.island.get("plan") or [])
        index = int(self.island.get("planIndex") or 0)
        for position, label in enumerate(plan):
            mark = "✓" if position < index else "…" if position == index else "○"
            out.append(f"{mark} {label}")
        for step in self.steps:
            mark = STATUS_MARKS.get(str(step.get("status") or ""), "·")
            detail = f"  ({step['detail']})" if step.get("detail") else ""
            out.append(f"{mark} {step.get('label') or step.get('id')}{detail}")
        return out

    def confirm_card(self) -> dict[str, Any] | None:
        """The safety card: a consequential action waiting for an explicit yes."""
        card = self.island.get("confirm")
        if card is None:
            return None            # only an explicit ``confirm=None`` clears it
        return {"title": str(card.get("title") or "Do this?"),
                "lines": [str(line) for line in (card.get("lines") or [])][:6],
                "confirm": str(card.get("confirm") or "Do it"),
                "name": str(card.get("name") or "")}

    def results(self) -> list[dict[str, Any]]:
        return [dict(item) for item in (self.island.get("results") or [])]

    def controls(self) -> list[dict[str, Any]]:
        """Every shell control with ``enabled`` and, when off, the reason to show.

        This is where "unsupported actions are visibly disabled with an
        explanation" actually happens: the window draws exactly these rows and
        never decides for itself what works.
        """
        caps, consent = self.capabilities, self.consent
        rows: list[dict[str, Any]] = []

        def add(control_id: str, label: str, *, cap: str = "", needs: str = "") -> None:
            reason = ""
            if cap and caps is not None and not caps.supports(cap):
                reason = caps.why_not(cap)
            elif needs and consent is not None and not consent.allows(needs):
                reason = consent.why_not(needs)
            rows.append({"id": control_id, "label": label, "enabled": not reason, "reason": reason})

        add("ask", "Ask (type and send)", cap="typed_input")
        add("talk", "Hold to talk", cap="push_to_talk")
        add("talk_engine", "Speech recognition", cap="speech_in")
        add("speak", "Read answers aloud", cap="speech_out")
        add("screenshot", "Look at my screen", cap="screen_capture", needs="screenshots")
        add("map", "Read the window map", cap="screen_context", needs="screen_context")
        add("point", "Point at it on screen", cap="pointing")
        add("share", "Share progress with my teacher", needs="share_with_teacher")
        add("shortcuts", "Run an Apple Shortcut", cap="shortcuts")
        add("applescript", "Mac system controls", cap="applescript")
        return rows

    def session_line(self) -> str:
        if self.consent is None:
            return "No learning session."
        return self.consent.summary()

    def render(self) -> dict[str, Any]:
        """Everything the window draws, in one snapshot."""
        return {"status": self.status_line(), "phase": self.phase,
                "transcript": str(self.island.get("transcript") or ""),
                "answer": str(self.island.get("answer") or ""),
                "offer": self.island.get("offer"),
                "checklist": self.checklist(), "confirm": self.confirm_card(),
                "results": self.results(), "shortcut": dict(self.shortcut),
                "controls": self.controls(), "session": self.session_line(),
                "notices": list(self.notices)}

    def lines(self) -> list[str]:
        """The same snapshot as plain text, for a headless run and for tests."""
        view = self.render()
        out = [f"[{view['status']}]"]
        if view["session"]:
            out.append(f"session: {view['session']}")
        if view["shortcut"].get("label"):
            works = "" if view["shortcut"].get("works", True) else "  (not listening)"
            out.append(f"hold {view['shortcut']['label']} to talk{works}")
        if view["transcript"]:
            out.append(f"you: {view['transcript']}")
        if view["answer"]:
            out.append(f"plip: {view['answer']}")
        out.extend(f"  {line}" for line in view["checklist"])
        card = view["confirm"]
        if card:
            out.append(f"? {card['title']}")
            out.extend(f"    {line}" for line in card["lines"])
            out.append(f"    [{card['confirm']}]  [No]")
        for item in view["results"]:
            out.append(f"  -> {item.get('title', '')}")
        if view["offer"]:
            out.append(f"? {view['offer']}   [Yes]  [No thanks]")
        off = [row for row in view["controls"] if not row["enabled"]]
        for row in off:
            out.append(f"  (off) {row['label']}: {row['reason']}")
        out.extend(f"  * {line}" for line in view["notices"])
        return out


__all__ = ["PHASE_WORDS", "STATUS_MARKS", "ShellView"]
