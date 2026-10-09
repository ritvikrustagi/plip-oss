"""Dependency guards: nothing Plip ships may import a Mac framework on Windows.

A Windows machine has no ``AppKit``, ``Quartz``, ``objc``, ``WebKit``,
``AVFoundation``, ``Speech`` or ``ApplicationServices``. These tests make the
absence real - every one of those names is replaced with a module that raises
on import - and then import the whole package, build the hosts, and run the
CLI. Anything that reaches for pyobjc at module scope fails here.
"""
from __future__ import annotations

import builtins
import sys

import pytest
from click.testing import CliRunner

MAC_ONLY = ("AppKit", "Foundation", "Quartz", "objc", "WebKit", "AVFoundation", "Speech",
            "ApplicationServices", "PyObjCTools", "PyObjCTools.AppHelper", "sherpa_onnx", "sounddevice")

# Modules that only do anything on a Mac. They still have to *import* on Windows, because
# the CLI's own module graph reaches some of them; what they must not do is touch pyobjc at
# module scope.
MAC_MODULES = {
    "mcp_vision.buddy.app_macos", "mcp_vision.buddy.island_macos", "mcp_vision.buddy.mascot_macos",
    "mcp_vision.buddy.overlay_macos", "mcp_vision.buddy.settings_macos", "mcp_vision.buddy.guide_macos",
    "mcp_vision.buddy.web_host", "mcp_vision.buddy.ax_context", "mcp_vision.buddy.ax_locator",
    "mcp_vision.buddy.parakeet", "mcp_vision.speech",
}


BLOCKED_ROOTS = {name.split(".")[0] for name in MAC_ONLY}

# Run inside a fresh interpreter: block every macOS-only module, then import what is
# asked for and report what broke. A subprocess is the point - importing the whole
# package under a block in *this* interpreter would leave half of it cached and the
# rest of the suite holding two copies of the same module.
PROBE = r"""
import importlib, json, pkgutil, sys

BLOCKED = set(%(blocked)r)


class Blocker:
    def find_module(self, name, path=None):
        return self if name.split(".")[0] in BLOCKED else None

    def find_spec(self, name, path=None, target=None):
        if name.split(".")[0] in BLOCKED:
            raise ImportError("No module named %%r (this machine is not a Mac)" %% name)
        return None


sys.meta_path.insert(0, Blocker())
wanted, skip = json.loads(sys.argv[1]), set(json.loads(sys.argv[2]))
import mcp_vision

names = wanted or [info.name for info in pkgutil.walk_packages(mcp_vision.__path__, "mcp_vision.")]
failures = {}
for name in names:
    if name in skip:
        continue
    try:
        importlib.import_module(name)
    except Exception as exc:
        failures[name] = "%%s: %%s" %% (type(exc).__name__, exc)
print(json.dumps(failures))
"""


def import_in_a_fresh_interpreter(names=(), skip=()) -> dict:
    """Import ``names`` (or the whole package) with no pyobjc. Returns name -> error."""
    import json
    import subprocess

    done = subprocess.run([sys.executable, "-c", PROBE % {"blocked": sorted(BLOCKED_ROOTS)},
                           json.dumps(list(names)), json.dumps(list(skip))],
                          capture_output=True, text=True, timeout=180)
    assert done.returncode == 0, done.stderr
    return json.loads(done.stdout.strip().splitlines()[-1])


@pytest.fixture
def no_pyobjc(monkeypatch):
    """In-process: make macOS-only imports fail, the way they do on Windows.

    Lightweight by design - it never re-imports ``mcp_vision`` itself, so it
    cannot leave a second copy of a module behind. The import sweep that does
    need that goes through ``import_in_a_fresh_interpreter``.
    """
    real_import = builtins.__import__

    def guarded(name, globals=None, locals=None, fromlist=(), level=0):
        if name in MAC_ONLY or name.split(".")[0] in BLOCKED_ROOTS:
            raise ImportError(f"No module named {name!r} (this machine is not a Mac)")
        return real_import(name, globals, locals, fromlist, level)

    for name in list(sys.modules):
        if name.split(".")[0] in BLOCKED_ROOTS:
            monkeypatch.delitem(sys.modules, name, raising=False)
    monkeypatch.setattr(builtins, "__import__", guarded)
    return guarded


@pytest.fixture
def on_windows(monkeypatch, no_pyobjc):
    """As above, plus every platform decision answering "windows".

    Plip reads the platform through ``platforms.current_platform`` rather than
    ``sys.platform`` directly, which is what makes this possible: patching
    ``sys.platform`` globally would also send the standard library down its
    Windows paths (``sysconfig``, ``asyncio``, ``shutil``) and fail on a Mac
    for reasons that have nothing to do with Plip.
    """
    import mcp_vision.platforms as platforms

    real = platforms.current_platform

    def pretend(platform=None):
        """"This machine is Windows", but an explicit platform still means itself."""
        return platforms.WINDOWS if platform is None else real(platform)

    monkeypatch.setattr(platforms, "current_platform", pretend)
    return monkeypatch


# -- the fixture itself has to bite ------------------------------------------------
def test_the_guard_really_blocks_pyobjc(no_pyobjc):
    with pytest.raises(ImportError, match="not a Mac"):
        __import__("AppKit")


def test_the_subprocess_guard_bites_too():
    assert "not a Mac" in import_in_a_fresh_interpreter(names=["AppKit"])["AppKit"]


# -- importing the package ---------------------------------------------------------
def test_every_module_in_the_package_imports_with_no_pyobjc():
    """Not a subset: every module, including the macOS hosts."""
    failures = import_in_a_fresh_interpreter()
    assert failures == {}, "these would crash on a Windows machine"


def test_the_macos_hosts_reach_for_pyobjc_only_when_called():
    # They import fine without it (every `import AppKit` is inside a function), which is
    # what keeps `plip --help`, `plip learn` and the Windows shell working on a machine
    # that has no pyobjc at all. Calling into them is a different matter - see below.
    assert import_in_a_fresh_interpreter(names=sorted(MAC_MODULES)) == {}


def test_calling_a_macos_host_without_pyobjc_fails_rather_than_half_working(no_pyobjc):
    import mcp_vision.buddy.web_host as web_host

    with pytest.raises(ImportError, match="not a Mac"):
        web_host._handler_class()


def test_the_windows_modules_need_nothing_from_a_mac():
    names = ["mcp_vision.platforms", "mcp_vision.buddy.win32", "mcp_vision.buddy.hotkey_windows",
             "mcp_vision.buddy.ui_context_windows", "mcp_vision.buddy.actions.host_windows",
             "mcp_vision.buddy.shell_windows", "mcp_vision.buddy.app_windows",
             "mcp_vision.buddy.shell_view", "mcp_vision.buddy.gated_capture",
             "mcp_vision.learning", "mcp_vision.learning.summary", "mcp_vision.learning.demo"]
    assert import_in_a_fresh_interpreter(names=names) == {}


# -- the CLI -----------------------------------------------------------------------
def runner_invoke(args):
    from mcp_vision.buddy.cli import buddy

    return CliRunner().invoke(buddy, args)


def test_help_works_with_no_pyobjc(no_pyobjc):
    result = runner_invoke(["--help"])
    assert result.exit_code == 0 and "learn" in result.output


@pytest.mark.parametrize("args", [["--help"], ["learn", "--help"], ["memory", "--help"],
                                  ["windows", "--help"], ["capabilities", "--help"], ["ask", "--help"]])
def test_every_command_group_can_be_asked_for_help(no_pyobjc, args):
    assert runner_invoke(args).exit_code == 0


def test_capabilities_prints_the_windows_table(on_windows):
    result = runner_invoke(["capabilities", "--no-probe"])
    assert result.exit_code == 0
    assert "Plip on windows" in result.output
    assert "AppleScript" in result.output and "PowerShell" in result.output


def test_capabilities_as_json_is_machine_readable(on_windows):
    import json

    result = runner_invoke(["capabilities", "--no-probe", "--json"])
    data = json.loads(result.output)
    assert data["platform"] == "windows"
    assert {row["id"] for row in data["capabilities"]} >= {"screen_capture", "push_to_talk", "applescript"}


def test_learn_status_works_before_anything_has_happened(no_pyobjc):
    result = runner_invoke(["learn", "status"])
    assert result.exit_code == 0 and "No session running" in result.output


def test_learn_contract_prints_v1(no_pyobjc):
    import json

    result = runner_invoke(["learn", "contract"])
    assert json.loads(result.output)["schemaVersion"] == 1


def test_run_on_an_unsupported_platform_says_what_to_do(no_pyobjc, monkeypatch):
    import mcp_vision.platforms as platforms

    monkeypatch.setattr(platforms, "current_platform", lambda platform=None: platforms.OTHER)
    result = runner_invoke(["run"])
    assert result.exit_code != 0 and "plip ask --image" in result.output


def test_run_on_windows_reaches_the_windows_shell(on_windows, monkeypatch):
    called = {}
    monkeypatch.setattr("mcp_vision.buddy.app_windows.run_windows_app",
                        lambda **options: called.update(options or {"started": True}))
    monkeypatch.setattr("mcp_vision.analytics.ping", lambda kind: None)
    result = runner_invoke(["run"])
    assert result.exit_code == 0 and called


def test_the_windows_command_reports_a_missing_tkinter(on_windows, monkeypatch):
    monkeypatch.setattr("mcp_vision.buddy.app_windows.tkinter_available",
                        lambda: (False, "Tkinter isn't in this Python."))
    result = runner_invoke(["windows"])
    assert result.exit_code != 0 and "Tkinter" in result.output


# -- the pieces that choose a platform ---------------------------------------------
def test_the_host_for_windows_is_the_windows_host(on_windows):
    from mcp_vision.buddy.actions.host import default_host
    from mcp_vision.buddy.actions.host_windows import WindowsHost

    assert isinstance(default_host(), WindowsHost)


def test_the_screen_map_for_windows_is_the_windows_reader(on_windows):
    from mcp_vision.buddy.factory import make_context
    from mcp_vision.buddy.ui_context_windows import WindowsUIContext

    context = make_context(None)
    if sys.platform == "win32":
        assert isinstance(context, WindowsUIContext)
    else:
        assert context is None, "no user32 here, so the reader declines rather than lying"


def test_actions_on_windows_refuse_the_applescript_ones(on_windows):
    from mcp_vision.buddy.factory import make_actions

    engine = make_actions(None)
    names = {entry["name"] for entry in engine.catalog()}
    assert "run_shortcut" not in names and "create_note" not in names
    assert "click" in names and "type_text" in names and "search_files" in names


def test_speech_in_on_windows_raises_instead_of_pretending(on_windows):
    from mcp_vision.buddy.settings import BuddySettings
    from mcp_vision.buddy.speech_in import ListenerCallbacks, make_listener

    with pytest.raises(RuntimeError) as caught:
        make_listener(BuddySettings(assemblyai_api_key=None), ListenerCallbacks())
    assert "type your question" in str(caught.value)


def test_asking_for_assemblyai_without_its_packages_names_them(on_windows):
    from mcp_vision.buddy.settings import BuddySettings
    from mcp_vision.buddy.speech_in import ListenerCallbacks, make_listener

    # sounddevice is blocked by the fixture, as it would be absent on a bare machine.
    with pytest.raises(RuntimeError, match="websockets"):
        make_listener(BuddySettings(stt="assemblyai", assemblyai_api_key="k"), ListenerCallbacks())


def test_parakeet_is_still_reachable_off_a_mac(on_windows, monkeypatch):
    """The platform guard must not sit in front of the engine choice.

    An earlier version gated the whole of make_listener on macOS, which broke
    `--stt parakeet` on Linux. Parakeet answers for itself through
    `parakeet.unavailable()`; nothing above it should pre-empt that.
    """
    import types

    from mcp_vision.buddy import parakeet, speech_in
    from mcp_vision.buddy.settings import BuddySettings

    monkeypatch.setattr(parakeet, "unavailable", lambda *args, **kw: "")
    monkeypatch.setattr(parakeet, "ParakeetListener", lambda callbacks: types.SimpleNamespace(name="parakeet"))
    listener = speech_in.make_listener(BuddySettings(stt="parakeet"), speech_in.ListenerCallbacks())
    assert listener.name == "parakeet"


def test_a_stubbed_apple_listener_is_still_honoured_off_a_mac(on_windows, monkeypatch):
    """The refusal lives in AppleListener, so replacing it replaces the refusal too."""
    import types

    from mcp_vision.buddy import speech_in
    from mcp_vision.buddy.settings import BuddySettings

    monkeypatch.setattr(speech_in, "AppleListener", lambda callbacks: types.SimpleNamespace(name="apple"))
    assert speech_in.make_listener(BuddySettings(), speech_in.ListenerCallbacks()).name == "apple"


def test_the_real_apple_listener_refuses_off_a_mac(on_windows):
    from mcp_vision.buddy.speech_in import AppleListener, ListenerCallbacks

    with pytest.raises(RuntimeError, match="No speech engine"):
        AppleListener(ListenerCallbacks())


def test_the_voice_on_windows_is_windows_own(on_windows, monkeypatch):
    import shutil

    monkeypatch.setattr(shutil, "which", lambda name: "powershell.exe" if "powershell" in name else None)
    from mcp_vision.buddy.speech_out import SapiVoice, default_voice

    voice, fallback = default_voice(None)
    assert isinstance(voice, SapiVoice) and voice.name == "windows"


def test_with_no_powershell_answers_stay_on_screen(on_windows, monkeypatch):
    import shutil

    monkeypatch.setattr(shutil, "which", lambda name: None)
    from mcp_vision.buddy.speech_out import PrintVoice, default_voice

    voice, _ = default_voice(None)
    assert isinstance(voice, PrintVoice)


def test_the_sapi_voice_keeps_the_text_out_of_the_command_line():
    from mcp_vision.buddy.speech_out import SapiVoice

    calls = []
    voice = SapiVoice(powershell="powershell.exe", runner=lambda argv, stop, env=None: calls.append((argv, env)))
    voice.play('say "); rm -rf /', __import__("threading").Event())
    argv, env = calls[0]
    assert "rm -rf" not in " ".join(argv)
    assert env["PLIP_SAY_TEXT"] == 'say "); rm -rf /'


def test_the_cursor_comes_from_user32_on_windows(on_windows, monkeypatch):
    from win_fakes import FakeUser32

    import mcp_vision.buddy.capture as capture_module
    import mcp_vision.buddy.win32 as win32_module

    monkeypatch.setattr(win32_module, "user32", lambda: FakeUser32(cursor=(11, 22)))
    assert capture_module.cursor_position() == (11.0, 22.0)


# -- where state lives -------------------------------------------------------------
def test_state_goes_to_localappdata_on_windows(monkeypatch, tmp_path):
    monkeypatch.delenv("MCP_VISION_STATE_DIR", raising=False)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "Local"))
    import mcp_vision.paths as paths

    monkeypatch.setattr(paths.sys, "platform", "win32")
    assert paths.state_dir() == tmp_path / "Local" / "Plip"


def test_config_goes_to_appdata_on_windows(monkeypatch, tmp_path):
    monkeypatch.delenv("MCP_VISION_CONFIG_DIR", raising=False)
    monkeypatch.setenv("APPDATA", str(tmp_path / "Roaming"))
    import mcp_vision.buddy.store as store

    monkeypatch.setattr(store.sys, "platform", "win32")
    assert store.config_dir() == tmp_path / "Roaming" / "Plip"


def test_windows_without_the_environment_variables_still_has_somewhere(monkeypatch):
    monkeypatch.delenv("MCP_VISION_STATE_DIR", raising=False)
    monkeypatch.delenv("LOCALAPPDATA", raising=False)
    import mcp_vision.paths as paths

    monkeypatch.setattr(paths.sys, "platform", "win32")
    assert paths.state_dir().parts[-3:] == ("AppData", "Local", "Plip")


def test_the_macos_paths_are_untouched(monkeypatch):
    monkeypatch.delenv("MCP_VISION_STATE_DIR", raising=False)
    monkeypatch.delenv("MCP_VISION_CONFIG_DIR", raising=False)
    import mcp_vision.buddy.store as store
    import mcp_vision.paths as paths

    monkeypatch.setattr(paths.sys, "platform", "darwin")
    monkeypatch.setattr(store.sys, "platform", "darwin")
    assert paths.state_dir().as_posix().endswith(".local/share/mcp-vision")
    assert store.config_dir().as_posix().endswith(".config/mcp-vision")


def test_the_environment_override_still_wins_everywhere(monkeypatch, tmp_path):
    monkeypatch.setenv("MCP_VISION_STATE_DIR", str(tmp_path))
    import mcp_vision.paths as paths

    monkeypatch.setattr(paths.sys, "platform", "win32")
    assert paths.state_dir() == tmp_path


# -- private files ------------------------------------------------------------------
def test_make_private_locks_a_file_down_on_posix(tmp_path):
    import stat

    from mcp_vision.paths import make_private

    target = tmp_path / "secret.env"
    target.write_text("ANTHROPIC_API_KEY=sk-ant-test")
    assert make_private(target) is True
    assert stat.S_IMODE(target.stat().st_mode) == 0o600


def test_make_private_asks_icacls_on_windows(on_windows, monkeypatch, tmp_path):
    """chmod is a no-op on NTFS, so Windows gets an icacls call instead."""
    import subprocess

    calls = []

    def fake_run(argv, **options):
        calls.append(argv)
        return subprocess.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setenv("USERNAME", "student")
    from mcp_vision.paths import make_private

    target = tmp_path / "secret.env"
    target.write_text("x")
    assert make_private(target) is True
    assert calls[0][0] == "icacls"
    assert "/inheritance:r" in calls[0] and "student:(F)" in calls[0]


def test_make_private_admits_when_it_could_not(on_windows, monkeypatch, tmp_path):
    import subprocess

    monkeypatch.setenv("USERNAME", "student")
    monkeypatch.setattr(subprocess, "run",
                        lambda *args, **options: (_ for _ in ()).throw(OSError("icacls missing")))
    from mcp_vision.paths import make_private

    target = tmp_path / "secret.env"
    target.write_text("x")
    assert make_private(target) is False, "the caller has to be able to tell"


def test_the_key_file_goes_through_it(tmp_path, monkeypatch):
    seen = []
    import mcp_vision.paths as paths

    monkeypatch.setattr(paths, "make_private", lambda path: seen.append(str(path)) or True)
    from mcp_vision.buddy.cli import write_env

    target = tmp_path / ".env"
    write_env(target, {"ANTHROPIC_API_KEY": "sk-ant-test"})
    assert seen == [str(target)]
