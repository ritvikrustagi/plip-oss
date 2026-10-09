"""Runtime state never belongs inside the installed package."""
import os
import sys
from pathlib import Path


def _default_state_dir() -> Path:
    """Where this OS expects a program to keep its own data.

    macOS and Linux keep the path Plip has always used, so an existing install
    finds its history and prefs where it left them. Windows has no
    ``~/.local/share`` convention, so state goes to ``%LOCALAPPDATA%\\Plip``.
    """
    if sys.platform == "win32":
        local = os.environ.get("LOCALAPPDATA")
        return (Path(local) if local else Path.home() / "AppData" / "Local") / "Plip"
    return Path.home() / ".local/share/mcp-vision"


def state_dir() -> Path:
    return Path(os.environ.get("MCP_VISION_STATE_DIR", _default_state_dir()))
