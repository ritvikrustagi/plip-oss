"""Supabase Postgres memory, accessed with the student's JWT through two RPCs.

The local cache and last synced snapshot are written atomically together. Only
changed facts are reapplied to a fresh remote snapshot, so an offline device does
not resurrect remotely deleted facts or discard another device's additions.
"""
from __future__ import annotations

import copy
import hashlib
import json
import threading
from dataclasses import asdict
from pathlib import Path
from uuid import UUID

from mcp_vision.buddy.account import Account, urllib_transport
from mcp_vision.buddy.memory import Fact, Memory, looks_sensitive
from mcp_vision.buddy.store import config_dir


class SyncError(RuntimeError):
    pass


def public_facts(facts: list[Fact]) -> list[dict]:
    # Recheck the content, even if an imported fact incorrectly says sensitive=False.
    return [asdict(fact) for fact in facts if not fact.sensitive and not looks_sensitive(fact.key, fact.value)]


def rebase(base: list[dict], local: list[dict], remote: list[dict]) -> list[dict]:
    """Apply this device's edits/deletions; unrelated remote changes survive."""
    before = {fact['id']: fact for fact in base}
    after = {fact['id']: fact for fact in local}
    merged = {fact['id']: fact for fact in remote}
    for removed in before.keys() - after.keys():
        merged.pop(removed, None)
    for key, fact in after.items():
        if before.get(key) != fact:
            merged[key] = fact
    return list(merged.values())


class Cache(Memory):
    def load(self) -> None:
        super().load()
        try:
            self.base = json.loads(self.path.read_text()).get('sync_base', [])
        except (OSError, ValueError):
            self.base = []

    def _data(self) -> dict:
        return {**super()._data(), 'sync_base': self.base}


class AccountMemory:
    """The existing Memory interface, isolated by project and account.

    Every access checks the account file, including after sign-out. Network I/O
    runs outside the cache lock; a reply for a previous account is discarded.
    Existing unscoped memory.json is deliberately never imported automatically.
    """

    def __init__(self, account: Account, *, root: Path | None = None,
                 transport=urllib_transport, background: bool = True):
        self.account = account
        project = hashlib.sha256(account.base.encode()).hexdigest()[:16]
        self.root = (root or config_dir() / 'memory-accounts') / project
        self.transport = transport
        self._lock = threading.RLock()
        self._sync_lock = threading.Lock()
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._owner = None
        self._cache = None
        self.error = ''
        self._synced = False
        self.on_change = lambda: None
        with self._lock:
            self._select()
        self._thread = None
        if background:
            self._thread = threading.Thread(target=self._run, daemon=True, name='jade-memory-sync')
            self._thread.start()

    def _select(self) -> Cache:
        owner, _ = self.account.memory_credentials()
        # Auth UUIDs are also directory names: reject malformed IDs, never accept paths.
        try:
            owner = str(UUID(owner)) if owner else ''
        except ValueError:
            owner = ''
        if owner != self._owner:
            self._owner = owner
            self._cache = Cache(self.root / (owner or 'signed-out') / 'memory.json')
            if not owner:
                self._cache.facts, self._cache.base = [], []
                self._cache.imports, self._cache.contacts, self._cache.handles = {}, [], []
            self.error = ''
            self._synced = False
            self._wake.set()
        return self._cache

    def __getattr__(self, name):
        # Resolve methods when called, not when first handed to the companion as
        # memory.summary. That callback can outlive a sign-in or sign-out.
        if name not in {'add', 'remove', 'forget_source', 'merge', 'best', 'values', 'profile', 'summary'}:
            raise AttributeError(name)

        def call(*args, **kwargs):
            with self._lock:
                cache = self._select()
                changing = name in {'add', 'remove', 'forget_source', 'merge'}
                if changing and not self._owner:
                    raise SyncError('Sign in before saving account memory.')
                result = getattr(cache, name)(*args, **kwargs)
                if changing:
                    self.save()
                return copy.deepcopy(result)
        return call

    def panel(self):
        with self._lock:
            cache = self._select()
            pending = not self._synced or public_facts(cache.facts) != cache.base
            status = self.error or ('Waiting to sync' if pending else 'Up to date')
            if not self._owner:
                status = 'Sign in to keep memory across sessions.'
            return {**cache.panel(), 'sync': {'enabled': True, 'available': bool(self._owner), 'status': status}}

    @property
    def facts(self):
        with self._lock:
            return copy.deepcopy(self._select().facts)

    @property
    def contacts(self):
        with self._lock:
            return copy.deepcopy(self._select().contacts)

    @contacts.setter
    def contacts(self, value):
        with self._lock:
            self._select().contacts = copy.deepcopy(value)

    @property
    def handles(self):
        with self._lock:
            return list(self._select().handles)

    @handles.setter
    def handles(self, value):
        with self._lock:
            self._select().handles = list(value)

    def save(self):
        with self._lock:
            cache = self._select()
            if self._owner:
                cache.save()
                self._wake.set()

    def for_account(self):
        """Pin a companion's callbacks to the account that started its requests."""
        with self._lock:
            self._select()
            return BoundMemory(self, self._owner)

    def _rpc(self, owner: str, name: str, body: dict) -> dict:
        current, token = self.account.memory_credentials()
        if current != owner or not token:
            raise SyncError('Sign in to sync memory.')
        headers = {'apikey': self.account.key, 'Authorization': f'Bearer {token}'}
        status, result = self.transport('POST', f'{self.account.base}/rest/v1/rpc/{name}', headers, body)
        if status == 401:
            self.account.refresh()
            current, token = self.account.memory_credentials()
            if current != owner or not token:
                raise SyncError('Sign in to sync memory.')
            headers['Authorization'] = f'Bearer {token}'
            status, result = self.transport('POST', f'{self.account.base}/rest/v1/rpc/{name}', headers, body)
        if not 200 <= status < 300:
            # Do not log response bodies, facts, or credentials.
            raise SyncError(f'Memory sync unavailable (HTTP {status}); changes are kept on this device.')
        if (not isinstance(result, dict) or not isinstance(result.get('revision'), int)
                or not isinstance(result.get('facts'), list)):
            raise SyncError('Invalid memory response; changes are kept on this device.')
        return result

    def sync(self) -> bool:
        """One retryable round trip; used by the background worker and CLI."""
        with self._sync_lock:
            with self._lock:
                cache = self._select()
                owner = self._owner
                if not owner:
                    self.error = 'Sign in to sync memory.'
                    return False
                base, local = copy.deepcopy(cache.base), public_facts(cache.facts)
            try:
                remote = self._rpc(owner, 'read_student_memory', {})
                for _ in range(4):
                    merged = rebase(base, local, remote['facts'])
                    if merged == remote['facts']:
                        break
                    remote = self._rpc(owner, 'write_student_memory', {
                        'expected_revision': remote['revision'], 'new_facts': merged})
                    if not remote.get('conflict'):
                        break
                else:
                    raise SyncError('Memory changed on another device; sync will retry.')
                incoming = [Fact(**fact) for fact in remote['facts']]
                with self._lock:
                    if self._select() is not cache:
                        return False
                    # Keep edits made while the request was in flight. Sensitive facts
                    # never enter the RPC or the synced baseline.
                    current = public_facts(cache.facts)
                    private = [fact for fact in cache.facts if fact.sensitive or looks_sensitive(fact.key, fact.value)]
                    kept = rebase(local, current, [asdict(fact) for fact in incoming])
                    cache.facts = [Fact(**fact) for fact in kept] + private
                    cache.base = remote['facts']
                    cache.save()
                    self.error = ''
                    self._synced = True
                return True
            except Exception as exc:
                with self._lock:
                    if self._select() is cache:
                        self.error = str(exc) if isinstance(exc, SyncError) else 'Memory sync unavailable; retrying later.'
                return False

    def _run(self):
        while not self._stop.is_set():
            self._wake.clear()
            self.sync()
            self.on_change()
            self._wake.wait(30)

    def close(self):
        self._stop.set()
        self._wake.set()


class BoundMemory:
    def __init__(self, memory, owner):
        self.memory, self.owner = memory, owner

    def __getattr__(self, name):
        with self.memory._lock:
            self.memory._select()
            if self.memory._owner != self.owner:
                raise SyncError('The account changed. Start a new request.')
            value = getattr(self.memory, name)
            if not callable(value):
                return value

        def call(*args, **kwargs):
            with self.memory._lock:
                self.memory._select()
                if self.memory._owner != self.owner:
                    raise SyncError('The account changed. Start a new request.')
                return value(*args, **kwargs)
        return call


def make_memory(settings, *, account=None, background=True):
    if not getattr(settings, 'memory_sync', False):
        return Memory()
    account = account or Account(settings.supabase_url, settings.supabase_key)
    if not account.available:
        raise ValueError('PLIP_MEMORY_SYNC requires PLIP_SUPABASE_URL and PLIP_SUPABASE_KEY.')
    return AccountMemory(account, background=background)
