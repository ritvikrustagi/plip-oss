"""The capability table has to be honest about both platforms, not optimistic."""
from __future__ import annotations

import pytest

from mcp_vision.platforms import (
    MACOS, OTHER, WINDOWS, action_guard, blocked_actions, capabilities, current_platform,
)


def test_platform_names():
    assert current_platform("darwin") == MACOS
    assert current_platform("win32") == WINDOWS
    assert current_platform("linux") == OTHER


def test_every_platform_lists_the_same_capabilities():
    mac = {row.id for row in capabilities("darwin").rows}
    win = {row.id for row in capabilities("win32").rows}
    other = {row.id for row in capabilities("linux").rows}
    assert mac == win == other, "a capability missing from one table would read as 'unknown' in the UI"


def test_windows_does_not_claim_apple_things():
    caps = capabilities("win32")
    for cap_id in ("applescript", "shortcuts", "notch_island", "mascot"):
        assert not caps.supports(cap_id), f"{cap_id} cannot work on Windows"
        assert caps.why_not(cap_id), f"{cap_id} needs a reason the person can read"


def test_windows_names_what_it_uses_instead():
    caps = capabilities("win32")
    assert "SendInput" in caps["click"].instead
    assert "SendInput" in caps["type_text"].instead
    assert "PowerShell" in caps["speech_out"].instead
    assert "top-centre" in caps["notch_island"].instead


def test_windows_speech_is_off_but_typing_is_on():
    caps = capabilities("win32")
    assert not caps.supports("speech_in")
    assert caps.supports("typed_input")
    assert caps.supports("push_to_talk"), "holding the keys works; it is recognition that is missing"
    assert "type" in caps.why_not("speech_in").lower()


def test_windows_grounding_is_supported_but_narrow():
    caps = capabilities("win32")
    assert caps.supports("screen_context")
    detail = caps["screen_context"].detail
    assert "blind" in detail and "never reads the text inside" in detail


def test_screenshots_are_described_as_opt_in():
    assert "switch it on" in capabilities("win32")["screen_capture"].detail


def test_push_to_talk_says_it_is_not_a_keylogger():
    row = capabilities("win32")["push_to_talk"]
    assert "cannot see what you type" in row.detail
    assert "no keyboard hook" in row.instead


def test_why_not_is_empty_for_a_supported_capability():
    assert capabilities("darwin").why_not("applescript") == ""


def test_unknown_capability_is_named_rather_than_silently_false():
    caps = capabilities("win32")
    assert caps.get("telepathy") is None
    assert "telepathy" in caps.why_not("telepathy")


def test_probing_does_not_change_the_capability_ids():
    plain = [row.id for row in capabilities("win32").rows]
    probed = [row.id for row in capabilities("win32", probe=True).rows]
    assert plain == probed


def test_probed_rows_say_they_were_probed():
    caps = capabilities("darwin", probe=True)
    assert caps["applescript"].evidence == "probed"
    assert caps["chat"].evidence == "platform", "nothing to probe, so don't claim we did"


def test_assemblyai_key_turns_windows_speech_on(monkeypatch):
    monkeypatch.setenv("ASSEMBLYAI_API_KEY", "abc123")
    row = capabilities("win32", probe=True)["speech_in"]
    assert row.supported and row.evidence == "probed" and "AssemblyAI" in row.instead


def test_blocked_actions_are_windows_only():
    assert blocked_actions("darwin") == {}
    blocked = blocked_actions("win32")
    assert set(blocked) == {"system", "run_shortcut", "list_shortcuts", "create_note", "create_reminder",
                            "read_page", "scroll_to"}
    assert all(len(reason) > 20 for reason in blocked.values()), "every refusal explains itself"


def test_blocked_actions_all_exist():
    from mcp_vision.buddy.actions import all_specs

    names = {spec.name for spec in all_specs()}
    missing = set(blocked_actions("win32")) - names
    assert not missing, f"these blocked names aren't real actions any more: {missing}"


def test_action_guard_passes_everything_on_macos():
    guard = action_guard("darwin")
    assert guard("run_shortcut") == ""


def test_action_guard_refuses_with_a_sentence_on_windows():
    guard = action_guard("win32")
    assert guard("click") == ""
    assert "AppleScript" in guard("system")


def test_groups_keep_table_order():
    groups = [name for name, _ in capabilities("win32").groups()]
    assert groups == ["core", "eyes", "voice", "hands", "system", "shell", "data"]


def test_other_platforms_fall_back_to_headless():
    caps = capabilities("linux")
    assert caps.supports("learning_events") and caps.supports("chat")
    assert not caps.supports("click")
    assert "plip ask --image" in caps.why_not("click")


def test_as_rows_is_json_safe():
    import json

    json.dumps(capabilities("win32").as_rows())


def test_getitem_raises_for_a_typo():
    with pytest.raises(KeyError):
        capabilities("win32")["screen_captures"]
