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


def make_private(path) -> bool:
    """Restrict a file to this user. Returns whether the OS could actually do it.

    ``os.chmod(path, 0o600)`` is the usual line, and on Windows it is close to a
    no-op: NTFS has no POSIX mode bits, Python reports 0o666 back, and the file
    stays readable by everyone else on the machine. That matters here, because
    the files this is used on are the API-key dotenv, the sign-in token, what
    Plip remembers about you and the learning pseudonym - on a shared school
    machine, exactly the files another student must not be able to open.

    So on Windows it asks ``icacls`` to drop inheritance and grant the current
    user alone. ``False`` means neither worked and the caller is writing a file
    other local users can read.
    """
    import os
    import subprocess

    from mcp_vision.platforms import WINDOWS, current_platform

    path = Path(path)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    if current_platform() != WINDOWS:
        return True
    user = os.environ.get("USERNAME") or ""
    if not user:
        return False
    try:
        done = subprocess.run(
            ["icacls", str(path), "/inheritance:r", "/grant:r", f"{user}:(F)"],
            capture_output=True, text=True, timeout=15, stdin=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return done.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False
