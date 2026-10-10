# Plip for school — student PWA + teacher summaries

A Chromebook-friendly study companion for students, and a summary for their
teacher of what they actually did. Browser only: no macOS APIs, no native
messaging, no Linux container, no developer mode, nothing to install on the
device beyond "add this page as an app".

**Full documentation: [`docs/CHROMEBOOK.md`](../../docs/CHROMEBOOK.md)** — setup,
managed-school constraints, the event contract, how the extension sends events,
what production has to provide, and the platform tests still outstanding.

> ### Two modes
> **`PLIP_MODE=demo`** — fixture sign-in, invented students, memory store. What
> `npm run dev` runs, with a warning on every screen.
>
> **`PLIP_MODE=production`** — OpenID Connect sign-in with your school's
> identity provider, SQLite, an imported roster, signed HttpOnly cookie
> sessions, CSRF, rate limiting, security headers and an audit trail. It
> refuses to start if anything needed to protect real data is missing, and it
> cannot read the demo fixtures at all.
>
> Switching the flag is not the same as being ready: TLS, backups, encryption
> at rest, a roster feed and a data processing agreement are still yours. There
> are no API keys in this bundle and there must never be.

```bash
npm install
npm run dev     # demo API on :4600, app on http://localhost:5273
npm run check   # typecheck + 88 tests (27 again on SQLite) + build + 26 browser flows

cp .env.example .env && npm start     # the production path; .env is commented line by line
```

## What is where

```
contracts/learning-event.schema.json   the shared event contract (v1) — the single source of truth
apps/education/
  shared/      contract loading, event factory + validator, access rules, summaries, retention
               plain .mjs with JSDoc types, so the browser, Node and the tests all run the same code
  server/
    app.mjs      the HTTP API, written once and used by both modes
    config.mjs   the environment, and the guards that keep the demo out of production
    auth/        OpenID Connect (PKCE, JWKS verification), signed cookie sessions, CSRF
    db/          the store, picked by mode: memory for the demo, SQLite for production
    security.mjs headers and rate limiting
    serve.mjs    production entry: the built app and the API on one origin
    demo-api.mjs demo entry
    roster-import.mjs   classes and enrolments from CSV
  fixtures/    synthetic tasks, concepts, classes, rosters, demo tokens and seed work
  src/         the PWA: student session and teacher dashboard (React, Vite, Tailwind)
  tests/       contract, access, summary, API (twice, once per store), production,
               and two Playwright suites — one per mode
  public/      manifest, service worker, icons
  Dockerfile   built from the repository root, not from here
```

The thing worth noticing: `shared/access.mjs` — the code that actually decides
who sees what — is the same file in both modes, and the API suite runs against
both stores. What changes between a demo and a school is who you are and where
the rows live, not the rules.

## The three rules this is built around

**1. Nothing is recorded until the student says so.** The opt-in screen lists
what is written down and what is not, in sentences, and the button under it is
the first thing that records anything. Pause records nothing. Sharing with a
teacher is a second, separate decision, off by default, reversible in both
directions — turning it off takes the work already recorded in that session back
out of the teacher's summary.

**2. The contract is the privacy boundary.** 
[`contracts/learning-event.schema.json`](../../contracts/learning-event.schema.json)
sets `additionalProperties: false`. An event carrying a screenshot, a URL, a
transcript, a prompt, a keystroke or an email address is refused with a 422 that
names the field. There is no setting that changes this.

**3. Measured, not known, and suggested never mix.** Counts came off the events.
Unknowns are stated rather than filled in. Suggestions are a fixed rule over the
counts, labelled as such, each carrying the `basis` it came from. The test suite
fails the build if the words attention, mastery, proficiency, engagement or
grade ever reach a teacher-facing string.

## Reused from Plip

This app is a separate bundle from [`ui/`](../../ui) (which builds a single HTML
file for the macOS host and is not touched here), but it is the same product:

- the tiny `Store` + `useSyncExternalStore` pattern from `ui/src/bridge.ts`;
- the ink/plip/dew/sun palette, glass and card surfaces from `ui/src/styles.css`;
- Plip's **ask before you act** rule — `Preview` in
  [`src/mcp_vision/buddy/actions/base.py`](../../src/mcp_vision/buddy/actions/base.py)
  and the island's confirm card — reused as `ConfirmCard`, for sharing, ending a
  session, marking a task finished and deleting everything;
- a hint ladder and step chips, in the same spirit as the island's plan steps.

## Running it for real

[`docs/CHROMEBOOK.md` → Running it for real](../../docs/CHROMEBOOK.md#running-it-for-real)
has the whole thing: what to set, what the process refuses to start without,
what it enforces, and — the longer list — what remains the school's.

Honest about the gaps: this has never met a real Google Workspace tenant, a
real certificate, a real Chromebook or a real roster. The OpenID client is
tested against a provider that generates a real RSA key and really signs its
tokens, and against Google's published discovery document, but no token from
Google has ever been exchanged. The Docker image has not been built.

MIT licensed, as the rest of the repository is. See [`LICENSE`](../../LICENSE).
