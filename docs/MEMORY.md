# Account memory in Postgres

Plip can sync explicit saved facts and preferences through the existing Supabase project. The desktop app's
remember/forget actions, Memory settings panel, and CLI use the same store. Retrieved facts feed the existing
bounded prompt summary. Sync is off by default; without it the existing local memory behavior is unchanged.

## Enable

1. Apply `supabase/migrations/20261010000000_student_memory.sql` to your Supabase project using its SQL editor
   or your migration deployment workflow. This requires the existing Supabase Auth setup in CONTRIBUTING.md.
2. Add these settings to your local Plip `.env` and restart the app:

   ```dotenv
   PLIP_SUPABASE_URL=https://<project>.supabase.co
   PLIP_SUPABASE_KEY=sb_publishable_...
   PLIP_MEMORY_SYNC=true
   ```

   Use the publishable/anon key, never a secret or service-role key. Requests also carry the current user's JWT.
3. Finish onboarding to create a guest account, or sign in with Google. Google sign-in on another device gives
   access to the same account's memory. A guest linked to Google retains its UUID and memory. Signing into an
   already existing Google account switches stores; it does not merge the old guest's data.
4. Run `plip memory sync` to check the connection. Use `plip memory sync --import-local` to explicitly copy facts
   from the old local `memory.json` into the current account. The original file is preserved. Detected sensitive
   facts are copied only to the local account cache. Imports are deduplicated by the existing memory logic.

The macOS app already has the sign-in flow. The CLI and Windows memory store can reuse a configured account
session, but this change does not add a Windows or extension sign-in flow. The browser extension still uses its
local store. A sync-enabled app with no account asks you to finish setup or sign in before adding/importing facts.
Once an account exists, its cached memory remains usable offline.

## Storage and access

`public.student_memory` stores one row per `auth.users.id`: a bounded JSONB array of structured facts, a revision,
and a server timestamp. Each fact retains its ID, key, value, sources and creation timestamp. An authenticated
account can select only its own row under row-level security. Unauthenticated requests have no access. The
client cannot insert, update or delete rows directly; writes use `write_student_memory`, which derives ownership
from `auth.uid()` and checks the expected revision. Account deletion cascades to memory.

These follow Supabase's [row-level security](https://supabase.com/docs/guides/database/postgres/row-level-security)
and [anonymous account](https://supabase.com/docs/guides/auth/auth-anonymous) semantics: an authenticated guest
has a user UUID and uses the authenticated role. A publishable key by itself is not a student identity.

The cache is `<config-dir>/memory-accounts/<project-hash>/<user-uuid>/memory.json`, restricted to the OS user.
It stores facts and the last synced baseline together. Sign-out switches away from that cache immediately;
signing in again can reuse it offline. Old cache files remain on disk, so separate OS accounts are still needed
on shared machines. Turning sync off returns to the original local-only file; it does not copy cloud facts there.

Only saved facts are synced. Detected passwords, card numbers, SSNs and other sensitive facts stay local, as do
contact lists, messaging handles, import diagnostics, raw conversations, screenshots and learning-event logs.
Sensitivity detection is heuristic, not a guarantee that arbitrary text contains no personal information.

## Offline use and conflicts

The app saves each change locally before trying the network. A background worker syncs on changes and every
30 seconds, and retries failures without blocking the UI. CLI commands sync synchronously and report failures.
Missing migrations or network errors leave edits pending on disk. Expired JWTs trigger a refresh and one retry.

The client rebases only changed/deleted facts onto the latest server document. Unrelated changes from another
device survive, and an unchanged offline copy does not resurrect a remote deletion. The server rejects stale
revisions atomically; the client rebases and retries up to four writes, then waits for its next sync. Conflicting
edits to the same fact use the last successfully applied local edit. Independent additions of the same text on
two devices can coexist because their fact IDs differ. The document is capped at 2,000 facts / 1 MiB; exceeding
the limit keeps changes local and reports a sync error rather than dropping data.

Deletion removes content from the cloud document on successful sync. Other devices learn of it on their next
successful sync; an offline cache can retain a copy until then. Database backup retention is managed by the
Supabase project. Run one Plip process per local cache; cross-process file locking is not implemented.

## Checks and current scope

`uv run pytest tests/test_postgres_memory.py` tests two-device sync, offline restart, conflicts, deletion,
account switching, late network replies, token refresh and explicit legacy import without a live service.

CI additionally runs the SQL assertions on PostgreSQL 17. To reproduce in a **disposable vanilla Postgres database**:

```sh
psql "$PLIP_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f supabase/tests/bootstrap.sql \
  -f supabase/migrations/20261010000000_student_memory.sql \
  -f supabase/tests/student_memory.sql
```

The bootstrap creates minimal Auth roles and tables solely for testing; never apply it to a deployed project.
The SQL checks cover unauthenticated denial, cross-account isolation, revision conflicts, validation and cascade
deletion. Neither the tests nor applying this code deploys the migration to a hosted project.

This is explicit account memory. Automatic session summaries, inferred learning progress, linking existing local
learning pseudonyms to accounts, teacher access and vector search are not implemented by this change.
