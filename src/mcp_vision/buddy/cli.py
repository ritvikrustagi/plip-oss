"""`plip`: run Plip, or ask it one question headlessly."""
from __future__ import annotations

import asyncio
import json
import os
import sys

import click


@click.group(invoke_without_command=True)
@click.pass_context
def buddy(ctx: click.Context) -> None:
    """Plip, your AI buddy in the notch: hold Control+Option, talk, and it points at things."""
    if ctx.invoked_subcommand is None:
        ctx.invoke(run)


@buddy.command()
def run() -> None:
    """Start Plip: the notch island on macOS, the top-of-screen strip on Windows."""
    from mcp_vision.buddy.factory import SetupError
    from mcp_vision.platforms import MACOS, WINDOWS, current_platform

    platform = current_platform()
    if platform not in {MACOS, WINDOWS}:
        raise click.ClickException("Plip's desktop shell needs macOS or Windows. "
                                   "Try: plip ask --image shot.png \"...\"")
    from mcp_vision.analytics import ping

    # Only the app pings: it runs for hours, so the request always finishes. A quick command
    # (`plip memory show`) could exit mid-request, and Python can crash tearing that thread down.
    ping("app")
    try:
        if platform == WINDOWS:
            from mcp_vision.buddy.app_windows import run_windows_app

            run_windows_app()
            return
        from mcp_vision.buddy.app_macos import run_buddy_app
        run_buddy_app()
    except SetupError as exc:
        raise click.ClickException(str(exc)) from exc
    except RuntimeError as exc:                 # no Tkinter, no user32: say what to do about it
        raise click.ClickException(str(exc)) from exc


@buddy.command()
@click.option("--headless", is_flag=True, help="Run with no window; prints the strip as text.")
@click.option("--once", is_flag=True, help="With --headless: print the strip, then exit (a smoke test).")
@click.option("--probe/--no-probe", default=True, help="Probe the brains (spawns the CLIs) before starting.")
def windows(headless: bool, once: bool, probe: bool) -> None:
    """Start (or smoke test) the Windows shell. --headless needs no display."""
    from mcp_vision.buddy.app_windows import run_windows_app

    try:
        run_windows_app(headless=headless or once, probe=probe, once=once)
    except RuntimeError as exc:
        raise click.ClickException(str(exc)) from exc


@buddy.command()
@click.option("--probe/--no-probe", default=True, help="Ask this machine, not just the OS name.")
@click.option("--json", "as_json", is_flag=True, help="Print the table as JSON.")
def capabilities(probe: bool, as_json: bool) -> None:
    """What Plip can and can't do on this machine, and what it uses instead."""
    from mcp_vision.platforms import capabilities as table

    caps = table(probe=probe)
    if as_json:
        click.echo(json.dumps({"platform": caps.platform, "capabilities": caps.as_rows()}, indent=2))
        return
    click.echo(f"Plip on {caps.platform}:")
    for group, rows in caps.groups():
        click.echo(f"\n  {group}")
        for row in rows:
            mark = "ok" if row.supported else "no"
            click.echo(f"    [{mark:>2}] {row.label}  ({row.evidence})")
            if row.detail:
                click.echo(f"         {row.detail}")
            if row.instead:
                click.echo(f"         uses: {row.instead}")


@buddy.command()
@click.argument("question")
@click.option("--image", "images", multiple=True, type=click.Path(exists=True, dir_okay=False),
              help="Use these images as the screens instead of capturing (repeatable).")
@click.option("--speak/--no-speak", default=False, help="Also say the answer out loud.")
@click.option("--json", "as_json", is_flag=True, help="Print the full turn result as JSON.")
@click.option("--engine", default=None, help="Brain to use: claude-code, codex, cursor, gemini, or anthropic.")
def ask(question: str, images: tuple[str, ...], speak: bool, as_json: bool, engine: str | None) -> None:
    """Ask one question about the screen and print what Plip says and points at."""
    from mcp_vision.buddy.capture import ScreenCapturer
    from mcp_vision.buddy.factory import SetupError, make_companion
    from mcp_vision.buddy.settings import load_settings
    from mcp_vision.buddy.speech_out import PrintVoice, QueueSpeaker
    from mcp_vision.buddy.store import Prefs

    prefs = Prefs.load()
    if engine:
        prefs.engine = engine
    settings = load_settings()
    capturer = (ScreenCapturer.from_images(list(images), max_edge=settings.max_image_edge,
                                           quality=settings.jpeg_quality) if images else None)
    speaker = None if speak else QueueSpeaker(PrintVoice(write=lambda text: None))
    try:
        from mcp_vision.buddy.memory import Memory

        from mcp_vision.buddy.usage import UsageLog

        companion = make_companion(settings, capturer=capturer, speaker=speaker, prefs=prefs, memory=Memory(),
                                   usage=UsageLog(), usage_kind="cli")
    except SetupError as exc:
        raise click.ClickException(str(exc)) from exc
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    from mcp_vision.buddy import workers

    workers.install(loop)
    # Not asyncio.run(): it waits for every worker thread, and a stuck screen grab or
    # CLI brain must not keep this one-shot command alive after it has answered.
    result = loop.run_until_complete(companion.respond(question))
    if as_json:
        click.echo(json.dumps({
            "engine": getattr(companion.brain, "label", None),
            "state": result.state, "error": result.error, "spoken": result.spoken,
            "did": result.did, "pending": result.pending, "plan": list(result.plan), "turns": result.turns,
            "outcome": result.outcome,
            "usage": ({"input": result.usage.input, "output": result.usage.output,
                       "cache_read": result.usage.cache_read, "cache_write": result.usage.cache_write,
                       "model": result.usage.model, "estimated": result.usage.estimated,
                       "cost_usd": round(result.usage.price(getattr(companion.brain, "name", "")), 6)}
                      if result.usage else None),
            "route": result.route.__dict__, "timings_ms": result.timings,
            "targets": [{**target.__dict__, "element": target.element.__dict__ if target.element else None}
                        for target in result.targets],
        }, indent=2))
    else:
        click.echo(result.spoken or result.error)
        for done in result.did:
            click.echo(f"  ✓ {done}")
        if result.pending:
            click.echo(f"  ? waiting for your OK: {result.pending}")
        for target in result.targets:
            click.echo(f"  -> {target.label or 'here'}: ({target.x:.0f}, {target.y:.0f}) on screen{target.screen}"
                       f"{' [snapped]' if target.source == 'snapped' else ''}")
        click.echo(f"  route={result.route.provider}/{result.route.intent} "
                   f"screens={'yes' if result.route.needs_screen else 'no'} "
                   f"first_speech={result.timings.get('first_speech', '-')}ms "
                   f"total={result.timings.get('spoken', '-')}ms", err=True)
    code = 0 if result.state == "done" else 1
    _finish(loop, companion, code)
    sys.exit(code)


def _finish(loop, companion, code: int = 0) -> None:
    """Close down without waiting on a worker that will never return (a hung screen grab)."""
    import threading
    import time

    pool = getattr(companion, "_pool", None)
    if pool is not None:
        pool.shutdown(wait=False, cancel_futures=True)
    loop.close()                       # shuts the default executor down without waiting
    deadline = time.monotonic() + 1.0
    stuck = []
    for thread in threading.enumerate():
        if thread is threading.main_thread() or thread.daemon:
            continue
        thread.join(max(0.0, deadline - time.monotonic()))
        if thread.is_alive():
            stuck.append(thread)
    if stuck:
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(code)


@buddy.group()
def memory() -> None:
    """See or import what Plip knows about you."""


@memory.command("show")
def memory_show() -> None:
    """Print the knowledge panel Plip uses."""
    from mcp_vision.buddy.memory import Memory

    store = Memory()
    if not store.facts:
        click.echo("Plip doesn't know anything about you yet. Try: plip memory import contacts")
        return
    for card in store.panel()["facts"]:
        click.echo(f"  {card['label']:<18} {card['value']}   ({', '.join(card['sources'])})")


@memory.command("import")
@click.argument("source", type=click.Choice(["contacts", "autofill", "mail", "chatgpt", "claude", "gemini"]))
@click.option("--file", "path", type=click.Path(exists=True, dir_okay=False), help="AI memory text to import.")
def memory_import(source: str, path: str | None) -> None:
    """Import your details from a source on this Mac, or AI memory from a file/stdin."""
    import os

    from mcp_vision.buddy.actions.host import default_host
    from mcp_vision.buddy.memory import Memory, importers

    store = Memory()
    error = ""
    if source in {"chatgpt", "claude", "gemini"}:
        text = open(path, encoding="utf-8").read() if path else click.get_text_stream("stdin").read()
        facts = importers.parse_ai_memory(text)
    elif source == "contacts":
        facts, error = importers.import_contacts(default_host())
    elif source == "mail":
        facts, error = importers.import_mail(default_host())
    else:
        facts, error = importers.import_autofill(os.path.expanduser("~"))
    added = store.merge(source, facts, error)
    store.save()
    if error and not facts:
        raise click.ClickException(error)
    click.echo(f"Imported {len(facts)} from {source} ({added} new).")


@memory.command("prompt")
def memory_prompt() -> None:
    """Print the prompt to paste into ChatGPT / Claude / Gemini to export their memory."""
    from mcp_vision.buddy.memory.importers import MEMORY_PROMPT

    click.echo(MEMORY_PROMPT)


@buddy.group()
def learn() -> None:
    """Learning sessions: opt in, see what was recorded, export it, delete it."""


@learn.command("start")
@click.option("--by", type=click.Choice(["student", "teacher", "guardian", "demo"]), default="student",
              help="Who is giving consent for this session.")
@click.option("--class", "class_id", default="", help="Class code, if a teacher summary is wanted.")
@click.option("--screenshots/--no-screenshots", default=False, help="Let Plip capture pixels this session.")
@click.option("--map/--no-map", "screen_map", default=False, help="Let Plip read the window map this session.")
@click.option("--share/--no-share", default=False, help="Mark this session's events shareable with a teacher.")
def learn_start(by: str, class_id: str, screenshots: bool, screen_map: bool, share: bool) -> None:
    """Start a session. Everything optional is off unless you ask for it."""
    from mcp_vision.learning import LearningSession

    session = LearningSession()
    try:
        session.start(granted_by=by, class_id=class_id, screenshots=screenshots,
                      screen_context=screen_map, share_with_teacher=share,
                      note="Started from the command line.")
    except ValueError as exc:
        raise click.ClickException(str(exc)) from exc
    click.echo(session.consent.summary())
    click.echo(f"  student id (local pseudonym): {session.student_id}")
    if share and not class_id:
        click.echo("  note: sharing is on but no class code was given, so no teacher can read it yet.")


@learn.command("status")
def learn_status() -> None:
    """What is running, what is on, and how much has been recorded."""
    from mcp_vision.learning import LearningLog, SessionConsent

    consent = SessionConsent.load()
    log = LearningLog()
    click.echo(consent.summary())
    for row in consent.as_rows():
        mark = "on" if row["on"] else "off"
        click.echo(f"  [{mark:>3}] {row['label']}")
        if not row["available"]:
            click.echo(f"         {consent.why_not(row['id'])}")
    events = log.events()
    click.echo(f"  {len(events)} event(s) kept, retention {log.max_age_days} days, at {log.path}")


@learn.command("pause")
def learn_pause() -> None:
    """Stop recording without ending the session."""
    from mcp_vision.learning import SessionConsent

    click.echo(SessionConsent.load().pause().save().summary())


@learn.command("resume")
def learn_resume() -> None:
    """Carry on recording."""
    from mcp_vision.learning import SessionConsent

    click.echo(SessionConsent.load().resume().save().summary())


@learn.command("stop")
def learn_stop() -> None:
    """End the session. Nothing is recorded afterwards."""
    from mcp_vision.learning import LearningSession, SessionConsent

    session = LearningSession(consent=SessionConsent.load())
    session.stop()
    click.echo("Session stopped. Nothing is being recorded.")


@learn.command("export")
@click.option("--json", "as_json", is_flag=True, help="One indented JSON array instead of JSON Lines.")
@click.option("--out", type=click.Path(dir_okay=False), default=None, help="Write to a file.")
def learn_export(as_json: bool, out: str | None) -> None:
    """Your own copy of every learning event on this machine."""
    from mcp_vision.learning import LearningLog

    log = LearningLog()
    text = log.export_json() if as_json else log.export()
    if out:
        from pathlib import Path

        Path(out).write_text(text, encoding="utf-8")
        click.echo(f"Wrote {len(log.events())} event(s) to {out}")
    else:
        click.echo(text, nl=False)


@learn.command("delete")
@click.option("--yes", is_flag=True, help="Don't ask.")
def learn_delete(yes: bool) -> None:
    """Delete every learning event, the session record and the local id."""
    from mcp_vision.learning import LearningSession

    if not yes:
        click.confirm("Delete all learning events, the consent record and this machine's student id?", abort=True)
    gone = LearningSession().forget_everything()
    click.echo(f"Deleted {gone} event(s), the consent record and the local student id.")


@learn.command("summary")
@click.option("--class", "class_id", required=True, help="The class to summarise.")
@click.option("--authorized-for", "authorized", multiple=True,
              help="A class you are authorised to read (repeatable). Required: no roster, no summary.")
@click.option("--student", default="", help="One student's pseudonymous id.")
@click.option("--json", "as_json", is_flag=True, help="Print the report as JSON.")
def learn_summary(class_id: str, authorized: tuple[str, ...], student: str, as_json: bool) -> None:
    """The teacher-facing summary: measured counts, then clearly-labelled inference."""
    from mcp_vision.learning import LearningLog
    from mcp_vision.learning.summary import class_summary, summarise_log

    log = LearningLog()
    allowed = list(authorized)
    if student:
        report = summarise_log(log, allowed_classes=allowed, student_id=student, class_id=class_id)
        click.echo(json.dumps(report.as_dict(), indent=2) if as_json else report.as_text())
        return
    everyone = class_summary(log, allowed_classes=allowed, class_id=class_id)
    if as_json:
        click.echo(json.dumps(everyone, indent=2))
        return
    if not everyone["authorized"]:
        raise click.ClickException(everyone["note"])
    if not everyone["students"]:
        click.echo(f"Nothing shared for class {class_id} yet.")
        return
    for entry in everyone["students"]:
        report = summarise_log(log, allowed_classes=allowed, student_id=entry["studentId"], class_id=class_id)
        click.echo(report.as_text())
        click.echo("")


@learn.command("demo")
@click.option("--seed", default=7, show_default=True, help="Which synthetic run to generate.")
def learn_demo(seed: int) -> None:
    """Write synthetic sessions so the summary can be seen working. No real data."""
    from mcp_vision.learning import LearningLog
    from mcp_vision.learning.demo import CLASS_ID, seed_log

    count = seed_log(LearningLog(), seed=seed)
    click.echo(f"Wrote {count} synthetic event(s) for class {CLASS_ID} (all invented).")
    click.echo(f"Try: plip learn summary --class {CLASS_ID} --authorized-for {CLASS_ID}")


@learn.command("contract")
def learn_contract() -> None:
    """What this build believes learning-event contract v1 is."""
    from mcp_vision.learning import contract_summary

    click.echo(json.dumps(contract_summary(), indent=2))


SETUP_KEYS = (
    ("ANTHROPIC_API_KEY", "Anthropic API key (skip it if you use Claude Code, Codex, Cursor, or Gemini)"),
    ("TYPESAFE_API_KEY", "TypeSafe Jev key for fast routing (optional; console.typesafe.ai)"),
    ("ELEVENLABS_API_KEY", "ElevenLabs key for a natural voice (optional)"),
    ("ASSEMBLYAI_API_KEY", "AssemblyAI key for streaming speech recognition (optional)"),
)


def write_env(path, values: dict[str, str]) -> None:
    """Merge keys into a dotenv file, keeping unrelated lines; the file is private (0600)."""
    import os
    from pathlib import Path

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = path.read_text().splitlines() if path.exists() else []
    remaining = dict(values)
    merged = []
    for line in lines:
        name = line.split("=", 1)[0].strip()
        if name in remaining:
            merged.append(f"{name}={remaining.pop(name)}")
        else:
            merged.append(line)
    merged.extend(f"{name}={value}" for name, value in remaining.items())
    path.write_text("\n".join(merged) + "\n")
    os.chmod(path, 0o600)


@buddy.command()
@click.option("--path", "env_path", type=click.Path(dir_okay=False), default=None,
              help="Where to write keys (default ~/.config/mcp-vision/.env).")
def setup(env_path: str | None) -> None:
    """Ask for API keys and save them where the buddy finds them."""
    from pathlib import Path

    target = Path(env_path) if env_path else Path.home() / ".config" / "mcp-vision" / ".env"
    click.echo(f"Keys are stored in {target} (readable only by you). Press Enter to skip one.")
    values = {}
    for name, prompt in SETUP_KEYS:
        value = click.prompt(f"  {prompt}", default="", show_default=False, hide_input=True).strip()
        if value:
            values[name] = value
    if not values:
        click.echo("Nothing saved.")
        return
    write_env(target, values)
    click.echo(f"Saved {', '.join(values)}. Next: plip doctor, then plip")


@buddy.command()
@click.option("--ping", is_flag=True, help="Make one tiny Jev request to verify the TypeSafe key.")
def doctor(ping: bool) -> None:
    """Check keys, voice, router, and macOS permissions for the buddy."""
    from mcp_vision.buddy.factory import make_jev
    from mcp_vision.buddy.settings import load_settings
    from mcp_vision.buddy.speech_out import default_voice

    settings = load_settings()
    ok = True

    def line(good: bool | None, name: str, detail: str) -> None:
        mark = {True: "ok", False: "FAIL", None: "--"}[good]
        click.echo(f"  [{mark:>4}] {name}: {detail}")

    from mcp_vision.buddy.engines import SPECS, choose_engine, probe
    from mcp_vision.buddy.factory import apply_prefs
    from mcp_vision.buddy.store import Prefs

    settings = apply_prefs(settings, Prefs.load())
    statuses = [probe(spec, settings) for spec in SPECS]
    active = choose_engine(settings, statuses)
    ok &= active is not None
    for status in statuses:
        # Only the brain you picked can fail; the others are just options.
        picked = status.spec.id == getattr(settings, "engine", "")
        good = True if status.status == "ready" else False if picked and status.status != "unknown" else None
        chosen = " <- Plip thinks with this" if active is not None and status.spec.id == active.spec.id else ""
        line(good, f"brain {status.spec.id}", f"{status.status}: {status.detail or status.spec.via}{chosen}")
    if active is None:
        line(False, "brain", "nothing ready: sign in to Claude Code / Codex / Cursor / Gemini, or add an API key")
    jev = make_jev(settings)
    if jev is None:
        line(None, "jev router", "TYPESAFE_API_KEY not set; using rule routing")
    elif ping:
        from mcp_vision.buddy.router import JevRouter

        route = asyncio.run(JevRouter(jev).route("where is the save button", []))
        good = route.provider == "jev"
        ok &= good
        line(good, "jev router", f"{settings.typesafe_model} answered in {route.latency_ms} ms" if good
             else "request failed; check the key at console.typesafe.ai")
    else:
        line(True, "jev router", f"{settings.typesafe_model} configured (use --ping to verify)")
    voice, fallback = default_voice(settings)
    line(True, "voice", voice.name + (f" (fallback {fallback.name})" if fallback else ""))
    if sys.platform == "darwin":
        from mcp_vision.native_permissions import native_permission_snapshot

        snap = native_permission_snapshot()
        for key, name in (("screenRecording", "screen recording"), ("accessibility", "accessibility"),
                          ("microphone", "microphone"), ("speechRecognition", "speech recognition")):
            value = snap.get(key)
            if key == "screenRecording":
                ok &= value is True
            line(value, name, {True: "granted", False: "denied", None: "not asked yet"}[value])
    elif sys.platform == "win32":
        from mcp_vision.platforms import capabilities as table

        caps = table(probe=True)
        line(None, "shell", "the top-of-screen strip (no notch, no AppKit on Windows)")
        from mcp_vision.buddy.app_windows import tkinter_available

        has_tk, why = tkinter_available()
        ok &= has_tk
        line(has_tk, "window", "Tkinter is here" if has_tk else why)
        for cap_id in ("screen_capture", "screen_context", "push_to_talk", "speech_in", "speech_out", "click"):
            row = caps[cap_id]
            line(row.supported, row.label.lower(), (row.instead or row.detail) if row.supported else row.detail)
        from mcp_vision.learning import SessionConsent

        line(None, "learning session", SessionConsent.load().summary())
        click.echo("  (`plip capabilities` lists everything, with what Plip uses instead)")
    else:
        line(None, "desktop shell", "macOS and Windows only; `plip ask --image` works everywhere")
    sys.exit(0 if ok else 1)
