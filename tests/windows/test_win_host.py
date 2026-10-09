"""``WindowsHost``: the native tool for each job, and a sentence where there isn't one."""
from __future__ import annotations

import subprocess

import pytest

from mcp_vision.buddy.actions.host import MacHost, NotSupported, PortableHost
from mcp_vision.buddy.actions.host_windows import WindowsHost
from mcp_vision.buddy.win32 import MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, VK, VK_CONTROL
from win_fakes import FakeUser32


def host(tmp_path=None, **options) -> WindowsHost:
    return WindowsHost(str(tmp_path) if tmp_path else None, input_api=FakeUser32(), **options)


# -- what it is ------------------------------------------------------------------
def test_it_is_a_portable_host_with_more():
    assert isinstance(host(), PortableHost)
    assert host().name == "windows"


def test_the_host_for_this_machine_is_chosen_by_platform(monkeypatch):
    from mcp_vision.buddy.actions import host as host_module

    monkeypatch.setattr(host_module.sys, "platform", "darwin")
    assert isinstance(host_module.default_host(), MacHost)
    monkeypatch.setattr(host_module.sys, "platform", "linux")
    assert type(host_module.default_host()) is PortableHost


# -- AppleScript and Shortcuts: refused, with a reason ---------------------------
def test_applescript_is_refused_in_words_a_person_can_use():
    with pytest.raises(NotSupported) as caught:
        host().osascript('tell application "Notes" to activate')
    assert "AppleScript" in str(caught.value) and "Windows Settings" in str(caught.value)


def test_shortcuts_are_refused_both_ways():
    for call in (lambda: host().shortcuts(), lambda: host().run_shortcut("Morning")):
        with pytest.raises(NotSupported, match="Apple Shortcuts"):
            call()


def test_setting_a_field_directly_is_refused_but_offers_the_alternative():
    with pytest.raises(NotSupported) as caught:
        host().set_field(1, 2, "x")
    assert "click it and type" in str(caught.value)


# -- PowerShell ------------------------------------------------------------------
def test_powershell_says_so_when_it_is_missing():
    with pytest.raises(NotSupported, match="PATH"):
        host(powershell="").powershell("Get-Date")


def test_powershell_runs_with_no_profile(monkeypatch):
    calls = []

    def fake_run(argv, **options):
        calls.append((argv, options))
        return subprocess.CompletedProcess(argv, 0, stdout="2026\n", stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    assert host(powershell="pwsh.exe").powershell("Get-Date") == "2026"
    argv = calls[0][0]
    assert argv[:4] == ["pwsh.exe", "-NoProfile", "-NonInteractive", "-Command"]


def test_powershell_failure_surfaces_its_message(monkeypatch):
    monkeypatch.setattr(subprocess, "run",
                        lambda argv, **options: subprocess.CompletedProcess(argv, 1, "", "Access denied"))
    with pytest.raises(RuntimeError, match="Access denied"):
        host(powershell="pwsh.exe").powershell("Stop-Computer")


def test_a_toast_that_fails_never_breaks_an_action(monkeypatch):
    monkeypatch.setattr(subprocess, "run", lambda *args, **options: (_ for _ in ()).throw(OSError("no toast")))
    host(powershell="pwsh.exe").notify("Plip", "done")      # must not raise


def test_toast_text_travels_in_the_environment_not_the_script(monkeypatch):
    seen = {}

    def fake_run(argv, **options):
        seen.update(argv=argv, env=options.get("env") or {})
        return subprocess.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(subprocess, "run", fake_run)
    host(powershell="pwsh.exe").notify("Plip", 'she said "); Remove-Item C:\\ #')
    assert "Remove-Item" not in " ".join(seen["argv"]), "nothing from the text may reach the command line"
    assert "Remove-Item" in seen["env"]["PLIP_TOAST_BODY"]


# -- opening things --------------------------------------------------------------
def test_open_uses_the_windows_shell_association():
    opened = []
    probe = WindowsHost(input_api=FakeUser32(), startfile=opened.append)
    probe.open("C:\\Users\\sam\\notes.txt")
    probe.open_app("C:\\Start Menu\\Word.lnk")
    assert opened == ["C:\\Users\\sam\\notes.txt", "C:\\Start Menu\\Word.lnk"]


def test_open_without_startfile_explains_itself():
    probe = WindowsHost(input_api=FakeUser32(), startfile=None)
    probe._startfile = None
    with pytest.raises(NotSupported):
        probe.open("x")


def test_reveal_asks_explorer_to_select_the_file(monkeypatch):
    calls = []
    monkeypatch.setattr("subprocess.Popen", lambda argv, **options: calls.append(argv))
    host().reveal("C:/Users/sam/Desktop/a.pdf")
    assert calls[0][1].startswith("/select,")


def test_start_menu_shortcuts_become_the_app_list(tmp_path, monkeypatch):
    programs = tmp_path / "Programs"
    (programs / "Accessories").mkdir(parents=True)
    (programs / "Word.lnk").write_text("")
    (programs / "Accessories" / "Notepad.lnk").write_text("")
    (programs / "readme.txt").write_text("")
    monkeypatch.setattr("mcp_vision.buddy.actions.host_windows.START_MENU_DIRS", (str(programs),))
    apps = host().list_apps()
    assert set(apps) == {"word", "notepad"}, "nested shortcuts count; other files don't"


# -- finding files ---------------------------------------------------------------
def test_it_walks_the_windows_folder_names(tmp_path):
    (tmp_path / "Videos").mkdir()
    (tmp_path / "Videos" / "recital.mp4").write_text("x")
    (tmp_path / "Movies").mkdir()
    (tmp_path / "Movies" / "recital-mac.mp4").write_text("x")
    hits = host(tmp_path).find_files("recital", "video")
    names = [hit.path for hit in hits]
    assert any("recital.mp4" in name for name in names)
    assert not any("recital-mac" in name for name in names), "Movies is a macOS folder"


def test_search_roots_differ_from_macos():
    assert "Videos" in WindowsHost.search_roots and "Movies" not in WindowsHost.search_roots
    assert "Movies" in PortableHost.search_roots


def test_kind_filter_still_applies(tmp_path):
    (tmp_path / "Documents").mkdir()
    (tmp_path / "Documents" / "essay.pdf").write_text("x")
    (tmp_path / "Documents" / "essay.exe").write_text("x")
    hits = host(tmp_path).find_files("essay", "pdf")
    assert [h.path.endswith(".pdf") for h in hits] == [True]


# -- keyboard and mouse ----------------------------------------------------------
def test_typing_goes_out_as_one_batch():
    api = FakeUser32()
    WindowsHost(input_api=api).type_text("ok")
    assert len(api.batches) == 1 and len(api.batches[0]) == 4


def test_typing_nothing_touches_nothing():
    api = FakeUser32()
    WindowsHost(input_api=api).type_text("")
    assert api.batches == []


def test_rewriting_a_selection_is_typing_over_it():
    api = FakeUser32()
    WindowsHost(input_api=api).replace_selection("new")
    assert len(api.batches[0]) == 6, "typing replaces the selection on Windows, so no extra keys"


def test_press_translates_the_mac_vocabulary():
    api = FakeUser32()
    WindowsHost(input_api=api).press("cmd+s")
    assert [event.ki.wVk for event in api.batches[0]] == [VK_CONTROL, VK["s"], VK["s"], VK_CONTROL]


def test_click_moves_then_presses():
    api = FakeUser32()
    WindowsHost(input_api=api).click(400, 300)
    assert api.moved == [(400, 300)]
    assert [event.mi.dwFlags for event in api.batches[0]] == [MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP]


def test_scroll_moves_to_the_point_first():
    api = FakeUser32()
    WindowsHost(input_api=api).scroll(10, 20, dy=2)
    assert api.moved == [(10, 20)]
    assert api.batches[0][0].mi.mouseData == (-2 * 120) & 0xFFFFFFFF


def test_drag_presses_moves_in_steps_and_releases():
    api = FakeUser32()
    WindowsHost(input_api=api).drag(0, 0, 60, 0)
    assert api.batches[0][0].mi.dwFlags == MOUSEEVENTF_LEFTDOWN
    assert api.batches[-1][0].mi.dwFlags == MOUSEEVENTF_LEFTUP
    assert api.moved[-1] == (60, 0) and len(api.moved) > 3


def test_mouse_position_comes_from_user32():
    assert WindowsHost(input_api=FakeUser32(cursor=(5, 6))).mouse_position() == (5.0, 6.0)


def test_no_user32_means_a_sentence_not_a_traceback():
    probe = WindowsHost(input_api=None)
    probe.input.api = None
    for call in (lambda: probe.type_text("x"), lambda: probe.press("cmd+s"),
                 lambda: probe.click(1, 1), lambda: probe.hover(1, 1)):
        with pytest.raises(NotSupported, match="user32"):
            call()


def test_refused_keystrokes_are_reported():
    probe = WindowsHost(input_api=FakeUser32(sent_ok=False))
    with pytest.raises(RuntimeError, match="blocking input"):
        probe.type_text("x")


# -- the grounding Plip does not have -------------------------------------------
def test_accessibility_only_answers_are_dont_know_not_lies():
    probe = host()
    assert probe.focused_role() is None
    assert probe.focused_scroll_area() is None
    assert probe.scroll_bar_step(1, 1, "down") is False
    assert probe.scroll_to_visible("Submit").found is False
