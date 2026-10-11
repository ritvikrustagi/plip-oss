"""Offline retry, concurrent devices, account isolation and prompt integration."""
import copy
import json
import threading
from dataclasses import asdict
from types import SimpleNamespace

import pytest
from click.testing import CliRunner

from mcp_vision.buddy.account import Account
from mcp_vision.buddy.cli import buddy
from mcp_vision.buddy.memory import Memory
from mcp_vision.buddy.memory.postgres import AccountMemory, SyncError, make_memory


A = '11111111-1111-4111-8111-111111111111'
B = '22222222-2222-4222-8222-222222222222'


class Server:
    def __init__(self):
        self.rows, self.calls = {}, []
        self.offline = False
        self.before_write = None

    def __call__(self, method, url, headers, body):
        self.calls.append((method, url, headers.copy(), copy.deepcopy(body)))
        if self.offline:
            raise OSError('offline')
        owner = headers['Authorization'].removeprefix('Bearer ')
        row = self.rows.setdefault(owner, {'facts': [], 'revision': 0})
        if url.endswith('write_student_memory'):
            if self.before_write:
                callback, self.before_write = self.before_write, None
                callback(row)
            if body['expected_revision'] != row['revision']:
                return 200, {**copy.deepcopy(row), 'conflict': True}
            row.update(facts=copy.deepcopy(body['new_facts']), revision=row['revision'] + 1)
        return 200, copy.deepcopy(row)


def login(account, owner=A):
    account._save({'user': {'id': owner, 'name': 'Student', 'email': 'student@example.test'},
                   'access_token': owner, 'refresh_token': 'refresh-' + owner})


def device(tmp_path, server, name='one', owner=A):
    account = Account('https://project.supabase.co', 'publishable', path=tmp_path / name / 'account.json')
    login(account, owner)
    memory = AccountMemory(account, root=tmp_path / name / 'memory', transport=server, background=False)
    return memory, account


def test_two_devices_and_prompt_reuse(tmp_path):
    server = Server()
    first, _ = device(tmp_path, server)
    first.add('note', 'Explain fractions with pictures')
    assert first.sync()
    second, _ = device(tmp_path, server, 'two')
    assert second.sync()
    assert 'Explain fractions with pictures' in second.for_account().summary()
    assert server.calls[0][2]['apikey'] == 'publishable'
    assert all('user_id' not in body for _, _, _, body in server.calls)


def test_offline_changes_and_deletions_survive_restart_without_resurrection(tmp_path):
    server = Server()
    first, acct = device(tmp_path, server)
    old = first.add('note', 'old preference')
    assert first.sync()
    second, _ = device(tmp_path, server, 'two')
    assert second.sync()
    server.offline = True
    first.remove(old.id)
    first.add('note', 'new preference')
    assert not first.sync()
    restarted = AccountMemory(acct, root=tmp_path / 'one' / 'memory', transport=server, background=False)
    server.offline = False
    assert restarted.sync()
    second.add('note', 'another device addition')
    assert second.sync()
    assert {f['value'] for f in server.rows[A]['facts']} == {'new preference', 'another device addition'}
    assert 'old preference' not in second.summary()


def test_revision_conflict_rebases_onto_latest_without_overwriting_other_device(tmp_path):
    server = Server()
    memory, _ = device(tmp_path, server)
    memory.add('note', 'mine')
    remote = Memory(tmp_path / 'remote.json')
    other = asdict(remote.add('note', 'theirs'))
    server.before_write = lambda row: row.update(facts=[other], revision=1)
    assert memory.sync()
    assert {f.value for f in memory.facts} == {'mine', 'theirs'}
    assert server.rows[A]['revision'] == 2


def test_sensitive_facts_and_contact_handles_never_uploaded(tmp_path):
    server = Server()
    memory, _ = device(tmp_path, server)
    memory.add('note', 'password: private-value', sensitive=False)
    memory.add('note', 'passport: X1234')
    memory.add('note', 'likes examples')
    memory.contacts, memory.handles = [{'handle': 'private-contact'}], ['private-handle']
    memory.save()
    assert memory.sync()
    assert [f['value'] for f in server.rows[A]['facts']] == ['likes examples']
    wire = json.dumps(server.calls)
    for secret in ('private-value', 'X1234', 'private-contact', 'private-handle'):
        assert secret not in wire
    assert len(memory.facts) == 3


def test_switch_account_and_sign_out_isolate_cache_and_existing_callbacks(tmp_path):
    server = Server()
    memory, acct = device(tmp_path, server)
    memory.add('note', 'belongs to A')
    bound = memory.for_account()
    summary, remember = bound.summary, bound.add
    dynamic_summary = memory.summary
    login(acct, B)
    assert memory.facts == [] and 'belongs to A' not in dynamic_summary()
    with pytest.raises(SyncError):
        summary()
    with pytest.raises(SyncError):
        remember('note', 'late write from A')
    memory.add('note', 'belongs to B')
    assert memory.sync()
    assert [f['value'] for f in server.rows[B]['facts']] == ['belongs to B']
    acct._forget()
    assert memory.facts == [] and not memory.sync()
    assert not memory.panel()['sync']['available']
    with pytest.raises(SyncError, match='Sign in'):
        memory.add('note', 'must not silently discard this')
    login(acct, A)
    assert [f.value for f in memory.facts] == ['belongs to A']


def test_sign_out_during_network_response_discards_old_account_data(tmp_path):
    server = Server()
    memory, acct = device(tmp_path, server)
    memory.add('note', 'A memory')
    server.before_write = lambda row: login(acct, B)
    assert not memory.sync()
    assert memory.facts == []
    assert memory.sync()
    assert server.rows[B]['facts'] == []


def test_edits_during_sync_remain_pending(tmp_path):
    server = Server()
    memory, _ = device(tmp_path, server)
    fact = memory.add('note', 'remove while uploading')

    def change(row):
        memory.remove(fact.id)
        memory.add('note', 'written while uploading')
    server.before_write = change
    assert memory.sync()
    assert [f.value for f in memory.facts] == ['written while uploading']
    assert memory.sync()
    assert [f['value'] for f in server.rows[A]['facts']] == ['written while uploading']


def test_expired_token_refreshes_and_retries(tmp_path):
    server = Server()
    memory, acct = device(tmp_path, server)
    called = []
    original = memory.transport

    def transport(*args):
        called.append(args)
        return (401, {}) if len(called) == 1 else original(*args)
    memory.transport = transport
    acct.refresh = lambda: called.append('refreshed')
    assert memory.sync()
    assert called[1] == 'refreshed'


def test_missing_migration_keeps_pending_memory_and_safe_error(tmp_path):
    server = Server()
    memory, acct = device(tmp_path, server)
    memory.add('note', 'do not lose this')
    memory.transport = lambda *args: (404, {'message': 'untrusted server details'})
    assert not memory.sync()
    assert '404' in memory.error and 'untrusted' not in memory.error
    restarted = AccountMemory(acct, root=tmp_path / 'one' / 'memory', transport=server, background=False)
    assert restarted.sync()
    assert server.rows[A]['facts'][0]['value'] == 'do not lose this'


def test_legacy_memory_not_uploaded_without_explicit_import(tmp_path, monkeypatch):
    monkeypatch.setenv('MCP_VISION_CONFIG_DIR', str(tmp_path))
    local = Memory()
    local.add('note', 'legacy local fact')
    local.save()
    server = Server()
    memory, _ = device(tmp_path, server)
    assert memory.sync() and server.rows[A]['facts'] == []
    monkeypatch.setattr('mcp_vision.buddy.cli._memory_store', lambda: memory)
    result = CliRunner().invoke(buddy, ['memory', 'sync', '--import-local'])
    assert result.exit_code == 0, result.output
    assert server.rows[A]['facts'][0]['value'] == 'legacy local fact'
    assert Memory().facts[0].value == 'legacy local fact'


def test_local_default_and_missing_config(monkeypatch):
    assert type(make_memory(SimpleNamespace(memory_sync=False))) is Memory
    with pytest.raises(ValueError, match='PLIP_SUPABASE_URL'):
        make_memory(SimpleNamespace(memory_sync=True, supabase_url=None, supabase_key=None))
    monkeypatch.setenv('PLIP_MEMORY_SYNC', 'false')
    result = CliRunner().invoke(buddy, ['memory', 'sync'])
    assert result.exit_code != 0 and 'PLIP_MEMORY_SYNC=true' in result.output


def test_refresh_in_flight_cannot_restore_signed_out_account(tmp_path):
    started, finish = threading.Event(), threading.Event()

    def refresh(*args):
        started.set()
        assert finish.wait(2)
        return 200, {'access_token': A, 'refresh_token': 'new',
                     'user': {'id': A, 'email': 'a@example.test'}}
    acct = Account('https://project.supabase.co', 'publishable', path=tmp_path / 'account.json', transport=refresh)
    login(acct)
    worker = threading.Thread(target=acct.refresh)
    worker.start()
    assert started.wait(2)
    acct._forget()
    login(acct, B)
    finish.set()
    worker.join(2)
    assert acct.memory_credentials() == (B, B)
