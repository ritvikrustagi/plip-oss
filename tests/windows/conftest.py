"""Shared setup for the Windows-port tests.

Three things:

* the shared companion fakes one directory up go on ``sys.path`` (pytest only
  adds a test file's own directory);
* every test gets its own state and config directory, because the learning
  layer writes a consent record to the state directory by default and one
  test's running session must not be another test's starting state;
* ``tkinter.Tk`` is made to raise. The Windows shell opens a real window, and
  a test that failed to stub that out would otherwise sit in ``mainloop()``
  for ever instead of failing.
"""
import sys
from pathlib import Path

import pytest

_TESTS = str(Path(__file__).resolve().parent.parent)
if _TESTS not in sys.path:
    sys.path.insert(0, _TESTS)


@pytest.fixture(autouse=True)
def private_state(tmp_path, monkeypatch):
    monkeypatch.setenv("MCP_VISION_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("MCP_VISION_CONFIG_DIR", str(tmp_path / "config"))
    return tmp_path


@pytest.fixture(autouse=True)
def never_open_a_window(monkeypatch):
    try:
        import tkinter
    except ImportError:
        return
    monkeypatch.setattr(tkinter, "Tk", _refuse)


def _refuse(*args, **options):
    raise RuntimeError("a test tried to open a real window; stub the shell out instead")
