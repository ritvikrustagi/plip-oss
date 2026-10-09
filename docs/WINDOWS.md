# Plip on Windows

Plip grew up in a MacBook's notch. This is the Windows port: the same
companion, the same walkthrough checklist, the same ask-before-you-act rule,
with the macOS-only parts replaced by what Windows actually has — and with the
parts that have no Windows equivalent switched off and labelled, rather than
faked.

It is also where Plip becomes a **student-facing learning assistant**: a
learning session you have to start by hand, events that are counts and concept
names, and a teacher summary that keeps measured evidence apart from guesswork.

> **Not verified on Windows yet.** Everything below was written and tested on
> macOS. The Win32 input path, the window reader and the hotkey poller are
> exercised against fakes that assert the exact bytes and calls Plip would make,
> and the whole package is import-checked in an interpreter with every pyobjc
> module blocked — but no line of this has run against a real `user32.dll`.
> See [What still needs a Windows machine](#what-still-needs-a-windows-machine).

---

## Getting a build to test

Three ways in, easiest first.

1. **A tagged release.** The Releases page carries `Plip-<version>-windows.zip` next to the Mac
   `.dmg` — the wheel, `install.ps1`, this document and a short README. Built and smoke-tested
   on a real `windows-latest` runner by the `windows` job in `.github/workflows/release.yml`.
2. **Any CI run, no tag needed.** Every push builds the wheel on Windows and uploads it as the
   `plip-windows-wheel` artifact. Open the run on the Actions tab, download it, then
   `pip install` the `.whl`. This is the quickest way to put a build in a tester's hands
   straight after a merge.
3. **One line in PowerShell**, straight from the repo:
   `irm https://raw.githubusercontent.com/hussainn7/plip-oss/main/scripts/install.ps1 | iex`

There is no signed installer and no MSI. Windows SmartScreen will warn about anything
unsigned; the pip route avoids that entirely, which is why it's the one the README leads with.

### What to ask a tester to report

`plip capabilities` and `plip doctor` first — their output says what this port believed about
the machine, which is the most useful thing to compare against what actually happened. Then the
list under [What still needs a Windows machine](#what-still-needs-a-windows-machine): the
window's look and placement, whether `Ctrl+Alt` is heard, whether typing and clicking land in
another application, whether the strip appears in its own screenshots, and whether `pytest`
passes.

## Running it

```powershell
# Python 3.12+ from python.org (keep the tcl/tk option: the window needs Tkinter)
py -3.12 -m venv .venv
.venv\Scripts\activate
pip install -e .

plip capabilities          # what this machine can and can't do, and what Plip uses instead
plip doctor                # keys, brain, voice, window
plip                       # the shell: a strip at the top of your screen
```

No brain yet? `plip doctor` says which to set up. Any of Claude Code, Codex,
Cursor, Gemini or an API key works the same as on macOS.

Useful variants:

```powershell
plip windows --once --no-probe   # build the shell, print it as text, exit (the CI smoke test)
plip windows --headless          # run with no window at all
```

State lives in `%LOCALAPPDATA%\Plip`, settings and keys in `%APPDATA%\Plip`.
macOS and Linux keep their old `~/.local/share/mcp-vision` and
`~/.config/mcp-vision` paths untouched, and `MCP_VISION_STATE_DIR` /
`MCP_VISION_CONFIG_DIR` still override both.

---

## What replaces what

Nothing here pretends. `plip capabilities` prints this table from
`src/mcp_vision/platforms/__init__.py`, and the shell greys out each row it
can't do with the same sentence next to it.

| What Plip does | macOS | Windows |
|---|---|---|
| The surface | notch island + mascot (AppKit + WKWebView) | a borderless, always-on-top strip at the top centre, drawn with Tkinter |
| Settings | the React dashboard in a WKWebView | the shell's own panel (plain widgets) — **the React UI is not ported** |
| Chat | voice or the island | **typing in the strip is first-class**, voice when it's set up |
| Push-to-talk | Quartz event tap (needs Accessibility) | `GetAsyncKeyState` polling of **four modifier keys only** — no keyboard hook |
| Speech in | on-device Apple Speech, or AssemblyAI | **none on-device**; AssemblyAI with a key, otherwise type |
| Speech out | `say` / `NSSpeechSynthesizer`, or ElevenLabs | SAPI through `System.Speech` in PowerShell, or ElevenLabs |
| Screenshots | `CGWindowListCreateImage`, Plip's own windows excluded | `mss`, **off until the session switches it on** |
| Screen map | the Accessibility tree: controls, page text, selection | window titles + visible Win32 child controls; **blind on browsers, Electron and UWP** |
| Clicking, scrolling, typing | Quartz events | `user32` `SendInput` |
| Key combos | mac key codes | virtual-key codes; **Command maps to Ctrl**, Option to Alt |
| Opening apps and links | `open -a`, the `/Applications` scan | `os.startfile`, the Start Menu's `.lnk` tree |
| Showing a file | `open -R` | `explorer /select,` |
| Finding files | Spotlight (`mdfind`), including file contents | a filename walk of your user folders — **slower, no content search** |
| Notifications | `display notification` | a Windows toast (`Windows.UI.Notifications`) |
| Dark mode, volume, display sleep | AppleScript | **not available** — AppleScript doesn't exist here |
| Apple Shortcuts | `shortcuts run` | **not available** — no Windows equivalent Plip can drive |
| Pointing at a spot on screen | the mascot flies there and labels it | **not available** — the strip names the target instead |
| Local memory | yours, on this machine | the same, minus the macOS importers (Contacts, Mail, browser autofill) |
| Learning events | the same | the same |

### Actions that are refused, by name

`platforms.blocked_actions()` keeps these out of the catalogue the model sees,
so it stops offering them, and refuses them with a sentence if one slips
through. On macOS the guard is a no-op.

| Action | Why not on Windows |
|---|---|
| `system` | dark mode / volume / display sleep go through AppleScript |
| `run_shortcut`, `list_shortcuts` | Apple Shortcuts are macOS-only |
| `create_note`, `create_reminder` | they write to Apple Notes and Reminders |
| `read_page` | reading a whole page needs the macOS Accessibility API |
| `scroll_to` | scrolling something into view needs `AXScrollToVisible` |

Everything else works: `click`, `scroll`, `press`, `drag`, `type_text`,
`replace_selection`, `open_app`, `open_url`, `web_search`, `search_files`,
`open_file`, `reveal_file`, `organize_desktop`, `undo`, `set_timer`,
`remember`, `forget`, `find_flights`.

### Confirmation safety is unchanged

A consequential action still builds a preview and waits. The strip shows the
card with the action's own wording and both answers; nothing runs until
**Yes** is clicked (or a spoken yes that names the same thing). `type_text`,
`organize_desktop`, anything that sends, deletes, submits, posts or spends —
all still ask. The engine, the matching rules and the money/undo logic are the
shared ones in `buddy/actions/engine.py`; the Windows port changed none of it.

---

## Privacy, by construction

This runs on a student's machine, so the limits are in the code, not in a
policy document.

**Push-to-talk is not a keylogger.** The obvious way to do hold-to-talk on
Windows is `SetWindowsHookEx`/`WH_KEYBOARD_LL`, which sees every keystroke in
every application. Plip doesn't install one. It polls `GetAsyncKeyState` for
Ctrl, Alt, Shift and Win — four keys, nothing else
(`tests/windows/test_win_hotkey.py::test_polling_asks_about_nothing_else`
asserts the exact set). The cost is one behaviour given up: on macOS a letter
typed during the chord cancels the press, and here Plip can't tell, so it
doesn't claim to.

**The window map never reads what you type.** It reads window titles, class
names and rectangles. It does not call `WM_GETTEXT` on an edit control — that
would be input capture. A control with `ES_PASSWORD` set is dropped entirely,
not just its text, and a control whose style can't be read is treated as a
password box and left out. Labels that look like a code, card or key go through
the same `looks_secret` filter macOS uses.

**No URLs, no browsing history.** A browser's address bar is an edit control,
so it falls under the rule above. Browser, Electron and UWP windows report
`blind=True` instead, exactly as the macOS reader does before a page exposes
itself.

**Screenshots are off by default and are never uploaded on their own.** The
capturer is wrapped in `GatedCapturer`: with the gate shut it returns an empty
list and the companion answers from the conversation instead. Display geometry
(how many screens, how big) still works, because the router needs it and it
isn't a picture of anything. Switching it on is a per-session choice in
**Session…**, and pausing the session shuts it again.

**No all-history collection.** `History` keeps the last 200 question/answer
pairs locally, as on macOS. The macOS memory importers (Contacts, Mail, browser
autofill) are deliberately **not** ported: reading a student's saved form data
is not something a learning assistant should do.

**No keys in code or in a bundle.** Keys stay in `%APPDATA%\Plip\.env` (written
0600 by `plip setup`) or the environment. Nothing in `src/` or the committed
web bundle contains one.

---

## Learning sessions and teacher summaries

### Starting one

Nothing is recorded until someone starts a session, and every switch inside it
starts off.

```powershell
plip learn start --by student --class 7B --share     # or use Session… in the shell
plip learn status                                    # what's on, what's recorded, where
plip learn pause                                     # stop recording, keep the session
plip learn resume
plip learn stop
```

| Switch | Default | What it allows |
|---|---|---|
| `screen_context` | off | reading the window map for grounding |
| `screenshots` | off | capturing pixels at all |
| `share_with_teacher` | off | marking this session's events eligible for a summary |

`granted_by` records who said yes — `student`, `teacher`, `guardian` or `demo`
— and `note` records what they were told. **Pause** stops all three at once;
**Stop** ends the session and clears the switches, so a stale reference can't
quietly resume collection.

### What an event contains

Contract v1, shared with the web/PWA and the browser extension so one
dashboard reads all three. `plip learn contract` prints what this build
believes it is.

```json
{"eventId":"…","schemaVersion":1,"sessionId":"…","studentId":"stu_9f3c…",
 "classId":"7B","timestamp":"2026-10-09T10:14:03+00:00","platform":"windows",
 "type":"task_completed","taskId":"task-frac-3","conceptIds":["fractions-add-unlike"],
 "evidence":{"attempts":2,"hintCount":1,"outcome":"correct","durationMs":184000,
             "studentConfirmed":true},
 "shareWithTeacher":true}
```

`studentId` is a local pseudonym: a random 16-byte secret written once and
hashed. It contains no name, login, hostname or MAC address, so an export
can't be walked back to a person without this machine's file.

What an event may **not** contain is enforced in code, not by convention.
`events.check_payload` refuses screenshots, URLs, window and page titles,
transcripts, prompt or answer text, keystrokes, selections, the clipboard,
names and email — by exact name and by suffix, at any depth — and names the
field in the error. A log line that has been tampered with to add one is
dropped on read rather than trusted.

### Retention, export, delete

* **Retention**: 30 days, trimmed on every write (`LearningLog.max_age_days`).
* **Export**: `plip learn export` (JSON Lines) or `--json` (one array), or
  **Export my data** in the shell.
* **Delete**: `plip learn delete` removes every event, the consent record *and*
  the machine's pseudonym. `delete_session` drops one session.

### The teacher summary

```powershell
plip learn demo                                               # synthetic data, all invented
plip learn summary --class demo-class --authorized-for demo-class
```

Two gates, both required: the event was recorded with `shareWithTeacher` true,
**and** the reader passed a class roster that includes the event's `classId`.
No roster means nothing is eligible — an empty list is an unauthorised reader,
not a permissive default.

The report has two halves that are never mixed:

```
Measured (straight from the opted-in event log)
  sessions shared        3
  tasks started          12
  tasks completed        4 (4 the student confirmed themselves)
  help requested         23 times
  attempts submitted     23
  concepts practised     fractions-equivalent x19, fractions-add-unlike x17, …

Inferred (hypotheses - please check with the student)
  - where it looked hard: Asked for help 4 times on task-frac-2. Worth asking what was in the way.
  - suggested follow-up: Try one more fractions-equivalent task together, …

This summary does not and cannot show:
  - attention or focus - nothing here measures where a student was looking
  - engagement or effort - time in the app is not effort
  - mastery or understanding - completing a task is not evidence of either
  - a grade or a score - these events were never designed to be marked
  - comparison between students - the counts depend on how each one chose to use Plip
```

Every inference carries the counts it rests on (`basis`) and a confidence of
`low` or `moderate`. Completions the student confirmed themselves are counted
separately from ones Plip decided. Screen time is not a field, and
`test_learning_summary.py` asserts the words "mastery", "attention",
"engaged", "grade" and "score" never appear in a finding.

### Consent, FERPA and COPPA

These are **design constraints this port was built against, not compliance
claims**. Nobody here has certified anything.

What the code gives a school that has to do the compliance work:

* a consent record with who granted it, when, and what they were told;
* a pseudonymous student id with no personal data in it;
* two independent authorisation gates on every teacher read;
* a 30-day default retention window, and a delete that really deletes;
* an export a student or guardian can take away;
* a list of claims the data cannot support, shipped with the data.

What is **not** built and would be needed for a real deployment: a
school-managed consent workflow (a guardian signing for a minor is currently
just `granted_by="guardian"`), an age gate, an audit log of teacher reads,
per-district retention policy, and a data-processing agreement with whoever
hosts the dashboard.

---

## Where the code is

| Path | What it is |
|---|---|
| `src/mcp_vision/platforms/__init__.py` | the capability table, the per-action guard |
| `src/mcp_vision/buddy/win32.py` | `SendInput` structures, key tables, the `user32` wrapper |
| `src/mcp_vision/buddy/actions/host_windows.py` | `WindowsHost`: the native tool for each job |
| `src/mcp_vision/buddy/hotkey_windows.py` | modifier polling, Windows chord names |
| `src/mcp_vision/buddy/ui_context_windows.py` | the window reader (and what it refuses to read) |
| `src/mcp_vision/buddy/gated_capture.py` | the opt-in screenshot and window-map gates |
| `src/mcp_vision/buddy/shell_view.py` | the shell's state, no widgets — platform-neutral |
| `src/mcp_vision/buddy/shell_windows.py` | the wiring: loop, companion, controller, session |
| `src/mcp_vision/buddy/app_windows.py` | the Tkinter strip and the headless runner |
| `src/mcp_vision/learning/` | consent, contract-v1 events, the log, the summary, demo data |
| `tests/windows/` | all of the above, against fakes |

Shared code that got a seam rather than a fork: `factory.make_context` and
`actions.host.default_host` pick per platform through
`platforms.current_platform`; `ActionEngine` took an `unsupported` hook;
`PortableHost` grew a `search_roots` class attribute; `make_companion` takes an
explicit `context=`. The macOS path through all of them is byte-identical.

---

## What still needs a Windows machine

Honest list of what this Mac could not answer.

**Cannot be verified here at all:**

1. `SendInput` actually moving the mouse and typing into a real application —
   the structures and flags are asserted, the syscall is not.
2. `GetAsyncKeyState` latency and whether 50 Hz polling catches a quick hold.
3. `EnumChildWindows` on real applications: how useful the control map is in
   Explorer, Word, Settings and a Win32 dialog, and whether `GetWindowRect`
   needs per-monitor DPI awareness (it almost certainly does — expect a
   `SetProcessDpiAwarenessContext` call to be needed on multi-DPI setups).
4. The Tkinter strip's appearance and behaviour: always-on-top against the
   taskbar, DPI scaling, multi-monitor placement, and whether it should be
   click-through.
5. `mss` screen capture on Windows, and whether Plip's own strip appears in
   the capture (on macOS it is excluded; there is no equivalent exclusion here
   yet, so **expect the strip to show up in screenshots**).
6. The SAPI voice: whether `System.Speech` is present on all editions, and how
   slow spawning PowerShell per sentence feels.
7. The `Windows.UI.Notifications` toast — it needs a registered AppUserModelID
   to show reliably, which an unpackaged `pip install` doesn't have.
8. AssemblyAI streaming: whether `sounddevice`'s PortAudio wheel picks the
   right default microphone.
9. The full test suite on Windows. It has never run there. Path-separator and
   permission assumptions in the *existing* tests are the likely first
   failures, which is why the Windows CI job is `continue-on-error` for now.

**Known gaps, not bugs:**

* The React settings dashboard isn't ported. It needs a WebView2 host or the
  bundle served over a local HTTP socket with a WebSocket bridge; the shell's
  own panel covers the controls that matter meanwhile.
* No mascot, so no pointing. The strip names the target instead.
* No tray icon or menu; the strip's own buttons are the whole surface.
* `find_files` doesn't search inside files. Driving Windows Search (the
  `Search.CollatorDSO` OLE DB provider) would fix it.
* No `set_field`, `focused_role`, `focused_scroll_area` or `scroll_to_visible`:
  those need UI Automation, which would also un-blind browsers and Electron.
  That is the single biggest improvement available and the right next project.
* Dark mode and volume could be done natively (registry, Core Audio) rather
  than left refused.
* No installer or packaged build; `pip install` only.

---

## Integration needs from the other surfaces

The web/PWA (Chromebook) and the browser extension write the same events.
Three things this port needs from them:

1. **`contracts/learning-event.schema.json`** — owned by the web/PWA side.
   `learning/events.py` is this build's Python mirror of it:
   `plip learn contract --json` prints `FIELDS`, `EVENT_TYPES`, `PLATFORMS`,
   `EVIDENCE_FIELDS`, `OUTCOMES` and the forbidden-field list. Please diff that
   against the schema; a drift should become a test on both sides.
2. **The teacher dashboard** should read `LearningLog.export_for_teacher(…)`
   output, or the same JSON Lines from any platform. The authorisation rule
   (opted-in **and** authorised class, no roster means nothing) is implemented
   in `LearningLog.eligible` and `summary.summarise_log` and should be the same
   rule server-side — the client filter is not the security boundary.
3. **Concept ids** need to be a shared vocabulary. This port treats them as
   opaque slugs and the demo data invents `fractions-equivalent`,
   `fractions-add-unlike`, `sentence-openers`, `paragraph-structure`. Whoever
   owns the curriculum should own the list.

### The landing page

There is a marketing site on the `jade-landing-and-case-studies` branch
(`site/index.html`). It has no download section at all today, and it isn't this
branch's to edit. Whoever owns it can drop this in, matching the existing `.btn`
class:

```html
<div class="downloads">
  <a class="btn" href="https://github.com/hussainn7/plip-oss/releases/latest">Download for Mac</a>
  <a class="btn ghost" href="https://github.com/hussainn7/plip-oss/releases/latest">Download for Windows</a>
  <p class="note">Mac: signed .dmg, macOS 13+. Windows: early unsigned build, Windows 10/11 —
    see <a href="https://github.com/hussainn7/plip-oss/blob/main/docs/WINDOWS.md">what works</a>.</p>
</div>
```

Please keep the "early unsigned build" wording until a Windows machine has actually
run it.

### Root files this port touched

`pyproject.toml` (Windows dependency markers, description), `uv.lock` (regenerated),
`.github/workflows/ci.yml` (a `windows-latest` matrix entry, a shell smoke step and a
wheel artifact), `.github/workflows/release.yml` (a `windows` job attaching the zip to
the same release as the DMG), `scripts/install.ps1` (new), `README.md` (a two-platform
Download section). Nothing under `apps/` or `site/` was touched.
