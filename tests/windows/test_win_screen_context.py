"""The Windows screen map: useful for grounding, and incapable of snooping.

The rules under test are the ones that make this safe to run on a student's
machine: no text out of a box you type in, password boxes left out entirely,
and browser/Electron windows reported as blind instead of guessed at.
"""
from __future__ import annotations

from mcp_vision.buddy.screen_context import ScreenContext
from mcp_vision.buddy.ui_context_windows import (
    BLIND_PROCESSES, ES_PASSWORD, WindowsUIContext, app_name, make_windows_context,
)
from win_fakes import ON_WINDOWS, FakeWin32UI, FakeWindow


def tree(*children, title="Untitled - Notepad", box=(0, 0, 800, 600), focused=0):
    top = FakeWindow(1, cls="Notepad", text=title, box=box, children=list(children))
    windows = [top, *children]
    return FakeWin32UI(windows, foreground=1, focused=focused)


def read(api) -> ScreenContext:
    return WindowsUIContext(api).snapshot()


# -- availability ----------------------------------------------------------------
def test_no_user32_means_no_map_rather_than_a_crash():
    probe = WindowsUIContext(None)
    probe.api = None                 # WindowsUIContext(None) means "use the real user32"
    assert not probe.available
    assert probe.snapshot() == ScreenContext()


def test_the_reader_declines_when_user32_is_missing():
    if ON_WINDOWS:
        assert make_windows_context() is not None
    else:
        assert make_windows_context() is None


def test_no_foreground_window_is_an_empty_map():
    assert read(FakeWin32UI([], foreground=0)) == ScreenContext()


def test_a_broken_api_is_an_empty_map_not_an_exception():
    class Broken:
        def GetForegroundWindow(self):
            raise OSError("gone")

    assert read(Broken()) == ScreenContext()


# -- what it does read -----------------------------------------------------------
def test_the_front_window_and_its_buttons():
    api = tree(FakeWindow(2, cls="Button", text="Save", box=(10, 20, 80, 30)),
               FakeWindow(3, cls="Button", text="Cancel", box=(100, 20, 80, 30)))
    context = read(api)
    assert context.window == "Untitled - Notepad"
    assert [control.label for control in context.controls] == ["Save", "Cancel"]
    assert context.controls[0].x == 50 and context.controls[0].y == 35, "centre, in screen points"
    assert context.window_frame.width == 800


def test_static_text_is_kept_apart_from_controls():
    api = tree(FakeWindow(2, cls="Static", text="Choose a file", box=(10, 10, 200, 20)),
               FakeWindow(3, cls="Button", text="Browse", box=(10, 40, 80, 24)))
    context = read(api)
    assert [item.label for item in context.texts] == ["Choose a file"]
    assert [item.label for item in context.controls] == ["Browse"]


def test_a_typed_box_is_pointable_but_has_no_value():
    api = tree(FakeWindow(2, cls="Edit", text="my private diary entry", box=(10, 10, 300, 24)))
    context = read(api)
    assert len(context.controls) == 1
    box = context.controls[0]
    assert box.role == "text box"
    assert box.value == "" and box.label == "", "what you type is never in the map"
    assert 2 not in api.read_text_of, "Plip must not even ask Windows for an edit control's text"


def test_a_password_box_is_dropped_entirely():
    api = tree(FakeWindow(2, cls="Edit", text="hunter2", box=(10, 10, 200, 24), style=ES_PASSWORD),
               FakeWindow(3, cls="Button", text="Sign in", box=(10, 40, 80, 24)))
    context = read(api)
    assert [control.label for control in context.controls] == ["Sign in"]
    assert all(control.role != "text box" for control in context.controls)


def test_a_box_whose_style_cannot_be_read_is_treated_as_a_password():
    class NoStyle(FakeWin32UI):
        def GetWindowLongW(self, handle, index):
            raise OSError("denied")

    api = tree(FakeWindow(2, cls="Edit", box=(10, 10, 200, 24)))
    unreadable = NoStyle(list(api.windows.values()), foreground=1)
    assert read(unreadable).controls == [], "when in doubt, leave it out"


def test_labels_that_look_like_secrets_are_left_out():
    api = tree(FakeWindow(2, cls="Static", text="One-time code", box=(10, 10, 200, 20)),
               FakeWindow(3, cls="Static", text="Your answer", box=(10, 40, 200, 20)))
    assert [item.label for item in read(api).texts] == ["Your answer"]


def test_slivers_and_offscreen_children_are_skipped():
    api = tree(FakeWindow(2, cls="Button", text="Hairline", box=(10, 10, 80, 2)),
               FakeWindow(3, cls="Button", text="Scrolled away", box=(5000, 10, 80, 24)),
               FakeWindow(4, cls="Button", text="Visible", box=(10, 40, 80, 24)))
    assert [control.label for control in read(api).controls] == ["Visible"]


def test_enumeration_is_capped():
    children = [FakeWindow(index, cls="Button", text=f"b{index}", box=(0, 0, 20, 20))
                for index in range(2, 60)]
    api = tree(*children)
    context = WindowsUIContext(api, max_children=5).snapshot()
    assert len(context.controls) == 5


# -- blindness is admitted, not guessed ------------------------------------------
def test_browsers_report_blind_with_no_controls(monkeypatch):
    api = tree(FakeWindow(2, cls="Button", text="Reload", box=(10, 10, 60, 24)),
               title="Plip - Google Chrome")
    monkeypatch.setattr("mcp_vision.buddy.ui_context_windows._process_name", lambda api, handle: "chrome.exe")
    context = read(api)
    assert context.blind is True
    assert context.controls == [] and context.texts == []
    assert context.url == "", "a browser's address bar is an edit control, so it is never read"


def test_the_blind_list_covers_the_usual_web_front_ends():
    for process in ("chrome.exe", "msedge.exe", "firefox.exe", "code.exe", "slack.exe", "teams.exe"):
        assert process in BLIND_PROCESSES


def test_a_win32_app_is_not_blind():
    assert read(tree(FakeWindow(2, cls="Button", text="OK", box=(0, 0, 40, 20)))).blind is False


# -- focus -----------------------------------------------------------------------
def test_focus_reports_the_kind_of_thing_only():
    api = tree(FakeWindow(2, cls="Edit", text="secret", box=(0, 0, 100, 20)), focused=2)
    assert read(api).focused == "text box"


def test_focus_on_a_password_box_says_password_box():
    api = tree(FakeWindow(2, cls="Edit", box=(0, 0, 100, 20), style=ES_PASSWORD), focused=2)
    assert read(api).focused == "password box"


def test_focus_on_a_button():
    api = tree(FakeWindow(2, cls="Button", text="Go", box=(0, 0, 40, 20)), focused=2)
    assert read(api).focused == "button"


def test_nothing_focused_is_empty():
    assert read(tree(FakeWindow(2, cls="Button", text="Go"), focused=0)).focused == ""


# -- app names -------------------------------------------------------------------
def test_app_name_prefers_the_process():
    assert app_name("msedge.exe", "anything") == "Microsoft Edge"
    assert app_name("winword.exe", "") == "Word"
    assert app_name("mything.exe", "") == "Mything"


def test_app_name_falls_back_to_the_title_tail():
    assert app_name("", "Report.docx - Word") == "Word"
    assert app_name("", "no separator here") == ""
