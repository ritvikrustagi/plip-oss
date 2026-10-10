# Plip on a Chromebook

A student-facing study companion and a teacher-facing summary of what the
student actually did, both running in Chrome on a managed Chromebook. No macOS
APIs, no native messaging, no Linux (Crostini), no developer mode, nothing to
side-load.

It lives in [`apps/education/`](../apps/education) and is built from browser
capabilities only. The code that reads the screen, moves the cursor and talks to
macOS (`src/mcp_vision/buddy/`) is not involved and is not reachable from here.

> **Two modes.** `PLIP_MODE=demo` is a fixture sign-in, invented students and
> an in-memory store — what `npm run dev` runs, with a warning on every screen.
> `PLIP_MODE=production` is school SSO over OpenID Connect, SQLite, an imported
> roster, CSRF, rate limiting and an audit trail, and it refuses to start if
> anything needed to protect real data is missing. The demo fixtures cannot be
> loaded in production at all.
>
> Switching the flag is not the same as being ready. [Running it for
> real](#running-it-for-real) lists both what the software enforces and what
> remains yours: TLS, backups, encryption at rest, a roster feed, a data
> processing agreement and the consent decisions underneath it.

---

## Contents

- [What it does](#what-it-does)
- [What it will not do](#what-it-will-not-do)
- [Run the demo](#run-the-demo)
- [Install it on a Chromebook](#install-it-on-a-chromebook)
- [Managed-school constraints](#managed-school-constraints)
- [Measured, not known, suggested](#measured-not-known-suggested)
- [The learning event contract](#the-learning-event-contract)
- [Sending events from the extension (or the desktop build)](#sending-events-from-the-extension-or-the-desktop-build)
- [Who can see what](#who-can-see-what)
- [Consent, FERPA and COPPA](#consent-ferpa-and-coppa)
- [Running it for real](#running-it-for-real)
- [Tests](#tests)
- [Getting an extension onto a Chromebook](#getting-an-extension-onto-a-chromebook)
- [Not duplicating the extension](#not-duplicating-the-extension)

---

## What it does

**For the student** (`#/student`, or just open the app)

- A practice session that only starts when they press a button that says what
  will be written down. Before that press, nothing is recorded at all.
- A study companion to talk to: type, or dictate if the browser can, with the
  same conversation either way.
- One task at a time, with the task's own step checklist, and a hint ladder
  that goes one rung at a time and never just hands over the answer.
- Visible session controls, always on screen: **Pause** (records nothing),
  **Share / Stop sharing** (reaches backwards as well as forwards), **End**.
- "What your teacher can see", built by asking the API for the teacher's own
  view of them, so it cannot drift from the truth; and underneath it, every
  event the session produced, in full, to read line by line.
- **Download everything held about me** and **Delete everything about me**.

**For the teacher** (`#/teacher`)

- Their classes, and only theirs. Their roster, and only students on it.
- Per class and per student: tasks completed (each confirmed by the student),
  help used, answers tried and how many matched the task's answer key, concept
  evidence, recent work, and session time.
- What the dashboard **cannot** tell them, stated as its own section: concepts
  in the class plan with no shared work, tasks begun and not finished, students
  who have shared nothing.
- Suggested follow-up, labelled as a suggestion, each row carrying the counts it
  was derived from.

## What it will not do

Not as a setting, not behind a flag, not in a future version:

- No screenshots, screen reading or screen recording.
- No keystroke logging, no clipboard reading, no password or form capture.
- No browsing history, no tab list, no URLs, no page text.
- No microphone or camera recording. Dictation, where the browser has it, is one
  press, one sentence, straight into the text box for the student to edit; the
  text is never uploaded as part of an event.
- No background or continuous collection. Nothing is recorded outside a session
  the student started, and nothing while it is paused.
- No claim about attention, focus, engagement, mastery, ability or a grade —
  from screen time or from anything else. Time with the app open is time with
  the app open, and the summary says so on every page.

## Run the demo

Needs Node 22 or newer. From `apps/education/`:

```bash
npm install
npm run dev          # demo API on :4600, app on http://localhost:5273
```

Then pick a demo identity. Students are `Avery L.`, `Bo T.` and `Eli M.`;
teachers are `Ms. Rivera` (Math 7 · Period 2, code `MATH-7A2`) and `Mr. Okafor`
(Math 7 · Period 4, code `MATH-7B4`). Avery is on both rosters on purpose — it
is the case that proves one teacher cannot see the other's class.

Other commands:

```bash
npm test             # the contract, access control, summaries, the demo API
npm run e2e          # a real browser: student session -> events -> teacher summary
npm run typecheck
npm run build        # dist/, a plain static folder
npm run api          # just the API (PORT, DEMO_RETENTION_DAYS)
npm run icons        # regenerate the PWA icons from assets/ (needs macOS sips)
npm run check        # typecheck + tests + build + both browser suites

# the production path, locally:
npm start                        # needs PLIP_MODE=production and .env filled in
npm run roster:import -- --classes classes.csv --enrolments enrolments.csv
```

`PLIP_DATABASE=/tmp/demo.sqlite npm run api` runs the demo fixtures in the
*production* storage engine, which is a useful halfway house: invented people,
real SQLite.



`npm run build` produces a static `dist/` with no server-side anything. Serving
it needs one rule: `/api/*` has to reach the API. In development Vite proxies
it; `tests/serve.mjs` is a 70-line example of the same thing for the built
output.

## Install it on a Chromebook

The app is a PWA, so installing it is a browser action and needs no ChromeOS
privileges at all.

1. Serve the built `dist/` over **HTTPS** (a service worker will not install
   over plain `http://`, except on `localhost`). Any static host the school
   already runs will do.
2. Open the URL in Chrome on the Chromebook.
3. Address bar → the **install** icon, or ⋮ → **Cast, save and share** →
   **Install page as app**.
4. It appears in the launcher and the shelf, opens in its own window, and
   starts offline from the service worker's cache.

A student who cannot or does not want to install it loses nothing: the same page
in a tab is the same app, minus the launcher icon and the offline start.

**What ChromeOS is used for:** the PWA manifest, the service worker, `fetch`,
`localStorage`/`sessionStorage`, and optionally `webkitSpeechRecognition` and
`speechSynthesis`. That is the whole list. There is no extension API, no native
messaging host, no filesystem access, no Linux container and no developer mode.

**Offline behaviour.** The service worker caches the app shell only. Learning
events wait in a small `localStorage` queue and go up when the network returns;
`/api` requests are never cached, so no student work ends up in a cache that
outlives the session.

## Managed-school constraints

A Chromebook handed out by a school is enrolled, and an admin decides a great
deal. What this app needs, and what breaks without it:

| Admin Console setting | Why | Without it |
| --- | --- | --- |
| The app's origin reachable (URL blocklist / allowlist) | everything | nothing loads |
| `WebAppInstallForceList` (optional) | installs it into the launcher for every student, no prompt | students install it themselves, or use a tab |
| Service workers / site data allowed for the origin | offline start, install | still works online, in a tab |
| `AudioCaptureAllowed` + microphone site permission (optional) | dictation | the mic button says dictation is unavailable; typing does everything |
| `DefaultJavaScriptSetting` allowed for the origin | everything | the page shows a one-line note and nothing else |
| Local storage not cleared on exit, if the offline queue matters | events survive a drop-out | queued events are lost on sign-out while offline |

Things the app deliberately does not ask an admin for: extension force-install,
native messaging hosts, enterprise reporting, screenshot or device-activity
reporting, printing, geolocation, USB, clipboard.

On a **shared** or **ephemeral-mode** Chromebook, `sessionStorage` and
`localStorage` are wiped when the student signs out. That is the right
behaviour, and it is why the demo token lives in `sessionStorage`: the next
student at that device starts at the sign-in screen, not inside someone else's
session.

## Measured, not known, suggested

Every teacher-facing block is one of three kinds, and the app never mixes them.
The split is enforced in [`shared/summary.mjs`](../apps/education/shared/summary.mjs)
and tested in [`tests/summary.test.mjs`](../apps/education/tests/summary.test.mjs).

**Measured** — counted directly off events the student chose to share. Tasks
started and finished, hints asked for, answers submitted and whether each
matched the task's own answer key, session time with pauses removed, and the
concepts the task declared. A fact about what happened, not a judgement.

**Not known** — stated, never filled in. Concepts in the class plan with no
shared work. Tasks begun and not marked finished. Students who shared nothing
(who may have done plenty). Work done outside a session, which leaves no trace
at all. A blank means nothing either way.

**Suggested** — a fixed rule over the measured counts. Deterministic, no model
involved, and every row carries its `basis`:

- 3 or more hints, or 2 or more answers that did not match the key → *worth
  asking about*;
- finished with no hints and no mismatched answers → *finished without hints*;
- some work, below those thresholds → *being practised*, explicitly "not enough
  to suggest anything either way";
- in the class plan, nothing shared against it → *no shared work yet*.

`scanForForbiddenClaims` runs over the whole summary in the test suite and fails
the build if the words attention, focus, engagement, mastery, proficiency,
grade, rank, or a handful of others ever reach a teacher-facing string. The
disclaimers are allowed to name them, because naming what is not being measured
is the point of a disclaimer.

Two consequences worth stating plainly:

- **Hints are not a deficit signal.** A student who asks for four hints used the
  help in front of them. The dashboard says "4 hints", and the suggestion says
  "ask them what the sticking point was" — not "struggling".
- **Finishing is the student's claim.** `task_completed` carries
  `studentConfirmed: true` because a person pressed a button that said so. The
  app never decides a task is done on their behalf.

## The learning event contract

One file, shared by every Plip learning surface:
[`contracts/learning-event.schema.json`](../contracts/learning-event.schema.json)
(JSON Schema 2020-12, owned by `apps/education`).

Three producers write contract-v1 events, in two languages:

| | |
| --- | --- |
| `apps/education/shared/events.mjs` | the web app, and the canonical validator |
| `apps/extension/src/lib/learning-events.js` | the Chrome side panel |
| `src/mcp_vision/learning/events.py` | the Windows desktop build |

They interoperate only if they agree, and they did not: two of them recorded an
outcome called `unknown` that the schema had no value for, one of them silently
rewrote any outcome it did not recognise into it, and every such event would
have been refused by the dashboard with nobody watching. Each producer is now
held to this file by a test — `tests/interop/contract-interop.test.mjs` builds
events with the extension's own module and validates them here, and
`tests/windows/test_learning_events.py` compares the Python module's
vocabulary against this JSON directly. The next disagreement fails a build
instead of a request.

```json
{
  "eventId": "evt_8581678ebeb3b4ae912dfc8e",
  "schemaVersion": 1,
  "sessionId": "ses_1f2e3d4c",
  "studentId": "stu_a1b2",
  "classId": "cls_math7a",
  "timestamp": "2026-10-09T17:10:57Z",
  "platform": "chromebook",
  "type": "task_completed",
  "taskId": "frac-add-1",
  "conceptIds": ["fractions.add-unlike"],
  "evidence": { "attempts": 2, "hintCount": 1, "outcome": "correct", "durationMs": 300000, "studentConfirmed": true },
  "shareWithTeacher": true
}
```

| Field | Notes |
| --- | --- |
| `eventId` | unique; a retried upload is stored once |
| `schemaVersion` | `1` |
| `sessionId` | the opted-in session |
| `studentId` | **pseudonymous**. School- or demo-issued. An `@` is refused by the schema; the id-to-person mapping lives in the roster system, never in an event |
| `classId` | only once the session is linked to a class. Required when `shareWithTeacher` is true |
| `timestamp` | ISO-8601, second precision, `Z` or an offset |
| `platform` | `windows` \| `chromebook` \| `extension` |
| `type` | `session_started` \| `task_started` \| `hint_requested` \| `attempt_submitted` \| `task_completed` \| `session_ended` |
| `taskId` | required for `task_started` and `task_completed`, which are definitionally about a task. Optional on `hint_requested` and `attempt_submitted`: a student can ask for help before they have picked anything, and refusing to record that would lose a hint rather than gain a guarantee |
| `conceptIds` | identifiers from the class plan. Not free text about the student |
| `evidence` | `attempts`, `hintCount`, `outcome`, `durationMs`, `studentConfirmed` — all optional, all measured. `outcome` is one of `correct`, `incorrect`, `partial`, `skipped`, `completed`, `incomplete`, `abandoned`. There is deliberately **no** value meaning "unknown": an outcome nobody reported is an *absent* outcome, and recording one would be a claim about nothing |
| `shareWithTeacher` | the student's decision, taken before the event was recorded |

The contract sets `additionalProperties: false` at the top level and inside
`evidence`. That is the mechanism, not a convention: an event carrying
`screenshot`, `url`, `transcript`, `prompt`, `keystrokes`, `email` or anything
else is refused with `422 contract_violation` and told which field was the
problem. [`shared/events.mjs`](../apps/education/shared/events.mjs) adds a
second pass (`scanForSensitiveContent`) that looks for those names at any depth,
so a nested blob cannot smuggle one through.

## Sending events from the extension (or the desktop build)

The extension owns `apps/extension`. It does not need to copy any of this code,
and it should not re-implement the summary logic.

`apps/extension` already does this, and
[`apps/extension/src/lib/learning-events.js`](../apps/extension/src/lib/learning-events.js)
is a worked example of a second producer against the same contract. It is held
to it by tests in `apps/education/tests/contract.test.mjs` that build events
with the *extension's* module and validate them against the canonical schema —
without those, the two drifted apart silently and every event the extension
sent would have been refused by a 422 nobody was watching for.

**The contract.** Validate against `contracts/learning-event.schema.json`. If
you are in a JS runtime, importing the two files below gets you the factory and
the validator with no dependencies:

```js
import { makeLearningEvent, validateLearningEvent } from '../education/shared/events.mjs'

const event = makeLearningEvent({
  type: 'hint_requested',
  sessionId,                 // from the session the student opted into
  studentId,                 // pseudonymous
  classId,                   // only when sharing
  platform: 'extension',     // <- the one field that differs
  taskId: 'frac-add-1',
  conceptIds: ['fractions.add-unlike'],
  evidence: { hintCount: 2 },
  shareWithTeacher: true,
})
```

`makeLearningEvent` throws rather than emit something invalid, drops `classId`
when `shareWithTeacher` is false, and refuses any field outside the contract.

**The wire.** `POST /api/events` with `Authorization: Bearer <token>`, body
either one event or `{ "events": [...] }` (200 max). Replies `202` with
`{ accepted: [{ eventId, stored }] }`. The demo API refuses, with a code you can
branch on:

| Code | Meaning |
| --- | --- |
| `contract_violation` (422) | the event does not match the schema — the message names the field |
| `not_own_data` (403) | the token's student is not the event's `studentId` |
| `not_own_session` (403) | the session belongs to another student |
| `class_mismatch` (403) | the event's `classId` is not the one its session is linked to |
| `class_not_joined` (403) | the student is not in that class |
| `session_paused` (409) | the session is paused; do not retry, drop it |
| `sharing_off` (409) | the event claims `shareWithTeacher` but its session is not sharing |
| `no_session` (404) | unknown `sessionId` |

Treat any 4xx as final — the message says why, and retrying hides it. Retry 5xx
and network failures with a queue, as `src/lib/session.ts` does.

**Sessions.** A session is created by the surface the student opted in on. If the
extension wants its own sessions it calls `POST /api/sessions` with
`{ consent: { sessionOptIn: true, shareWithTeacher }, joinCode }` and uses the
`sessionId` it gets back. If a student is working in the web app and the
extension is observing alongside, the extension should attach to the web app's
`sessionId` rather than open a second one — two sessions would double-count
session time.

**Concept ids** are identifiers from the class plan, not free text about a
student: `^[a-z0-9][a-z0-9._-]{0,63}$`. A label that came from a person or a
model goes through `normaliseConceptId` first, so "Adding Fractions" becomes
`adding-fractions` rather than being refused at the far end — but anything
URL-shaped is handed straight to the validator and refused by name, because
slugifying a smuggled URL into a well-formed concept id is the opposite of the
point.

**What not to send.** The contract will stop you, but to be explicit: no URLs,
no page titles, no page text, no selections, no DOM, no screenshots, no
transcripts, no prompts, no keystrokes. If the extension cannot describe what a
student did in terms of `taskId`, `conceptIds` and the five `evidence` counts,
that thing does not belong in a learning event.

## Who can see what

Three rules, checked on every request in
[`shared/access.mjs`](../apps/education/shared/access.mjs) — the same file, the
same code, in both modes. Only who you are differs: a fixture token in the
demo, a verified school sign-in in production.

1. **Role.** A student may write their own events and read their own data. A
   teacher may read class summaries. Neither can do the other's job: a teacher
   cannot open a session or post an event, a student cannot read a roster.
2. **Authorized class membership.** A teacher reaches a class only if their
   identity lists it *and* the class record lists them. A class that does not
   exist and a class that is not yours give the same 403 with the same message —
   a 404 that only appears for other teachers' classes is itself a roster leak.
   Within a class, only students the roster lists.
3. **Eligible opt-in.** A teacher summary is built only from events with
   `shareWithTeacher: true`, carrying that exact `classId`, from a student on
   that roster. All three, or the event is not there.

Two more, which matter more than they look:

- **Students are never shown a roster.** `GET /api/classes` returns a class
  name and its concept plan to a student, and the join code and student count
  only to a teacher.
- **Private work is invisible, including its volume.** A teacher summary is not
  told how many events a student kept private, or that any exist. The student's
  own copy of the same summary does show that count, because it is their data.

Turning sharing off reaches backwards: `POST /api/sessions/:id/sharing` with
`false` flips every event already stored for that session to
`shareWithTeacher: false` and strips its `classId`. The student's own export
keeps it.

## Consent, FERPA and COPPA

**These are design constraints, not compliance claims.** Nothing here has been
reviewed by a lawyer, nothing has been audited, and no statement in this
repository should be read as saying this software is FERPA- or COPPA-compliant.
Compliance is a property of a deployment — a school, a contract, a data
inventory, a retention policy, a breach plan — not of a repository.

What the design does, so that a school *could* run it inside those rules:

- **Session opt-in is explicit and per session.** A student reads what is
  recorded and what is not, then presses a button. There is no implied consent
  and no remembered answer.
- **Sharing with a teacher is a second, separate decision**, off by default, and
  reversible at any moment in either direction.
- **Data minimisation by construction.** The contract cannot carry screen
  content, browsing, transcripts or identities. There is no field to misuse.
- **Pseudonymous identifiers.** Events carry `stu_a1b2`. The name sits in the
  roster, behind the role check, and never travels on an event.
- **Retention is short and enforced on every read and write**, not by a nightly
  job that might not run. The demo keeps 7 days (`DEMO_RETENTION_DAYS`).
- **Export and delete are student-facing buttons**, not a support request.
- **Purpose limitation is visible.** The summary says what it is for and what it
  is not evidence of, on every page.

What a school still has to do, and what this repository cannot do for it:

- Decide whether a school official / legitimate educational interest basis
  applies under FERPA, and record that decision.
- For students under 13, obtain the consent COPPA requires — in a school
  deployment, usually the school acting for parents, under a written agreement
  that says so.
- Tell students and parents, in their own notice, what is collected and why.
- Keep the roster-to-person mapping in the system of record, and name a data
  owner. (The access log and the retention window are implemented; reading the
  log and choosing the window are still yours.)
- Decide whether learning events are education records in their jurisdiction,
  and handle access and correction requests accordingly.
- Run its own review before any of this touches a real child's work.
## Running it for real

There are two modes and nothing in between. `PLIP_MODE=production` turns on
school sign-in, a real database and a real roster, and turns the demo off hard:
the fixture loader refuses to open `apps/education/fixtures/` at all, and
`/api/demo/identities` stops existing.

### What you need

- **Node 24 or newer.** `node:sqlite` is only built in from Node 24; on Node 22
  it exists but needs `--experimental-sqlite`, and the server says so rather
  than failing cryptically. (The *demo* runs on Node 22 — it never loads
  `node:sqlite` unless you give it `PLIP_DATABASE`.) No other runtime
  dependency: the server is built from `node:` modules only.
- **A hostname with TLS.** Session cookies are `Secure` and a service worker
  will not install without it. Terminate TLS at a reverse proxy.
- **An OpenID Connect provider.** Google Workspace for Education is the one
  this is written against; anything publishing a discovery document and signing
  RS256 or ES256 works the same way.
- **A class roster**, as two CSV files or whatever your SIS can export.
- **An encrypted, backed-up volume** for the database file.

### Set it up

```bash
cd apps/education
npm ci
npm run build                     # dist/, a static folder served by the same process

cp .env.example .env              # then fill it in - it is commented line by line
openssl rand -base64 48           # PLIP_SESSION_SECRET
```

Register the redirect URI with your identity provider, exactly:

```
https://plip.your-school.example/api/auth/callback
```

For Google: Cloud Console → APIs & Services → Credentials → OAuth client ID →
Web application. Scopes `openid email profile`. The client secret goes in
`.env` on the server and **never** anywhere near the browser bundle.

Import the roster:

```csv
# classes.csv
classId,name,joinCode,plannedConceptIds
cls_math7a,"Math 7 · Period 2",MATH-7A2,"fractions.add-unlike;fractions.simplify"

# enrolments.csv
classId,email,role
cls_math7a,rivera@school.example,teacher
cls_math7a,avery@school.example,student
```

```bash
npm run roster:import -- --classes classes.csv --enrolments enrolments.csv
npm start                         # or: node server/serve.mjs
```

Or with Docker, **built from the repository root** (the event contract lives
there and both the bundle and the server import it):

```bash
docker build -t plip-school -f apps/education/Dockerfile .
docker run --env-file apps/education/.env -p 8080:8080 \
  -v plip-data:/var/lib/plip -v /etc/plip:/etc/plip:ro plip-school
```

### It refuses to start rather than start unsafely

Every one of these stops the process with a message that says what to do:

| Missing or wrong | Why it is fatal |
| --- | --- |
| `PLIP_SESSION_SECRET` under 32 characters | a guessable secret is a forgeable session |
| `PLIP_PUBLIC_ORIGIN` not `https://` | `Secure` cookies and the service worker both need TLS. `PLIP_ALLOW_INSECURE=1` is the deliberate override for testing on localhost |
| `PLIP_DATABASE` unset, or `:memory:` | an in-memory database loses every student's work on restart |
| `PLIP_CATALOGUE` missing | production must supply its own curriculum; the demo fixtures are not curriculum |
| any `PLIP_OIDC_*` missing | there would be no way to sign anybody in |
| `PLIP_OIDC_ALLOWED_DOMAINS` empty | without it, anyone with an account at the provider could sign in |

### What is enforced

**Sign-in.** OpenID Connect authorization code flow with PKCE. `state` and
`nonce` are generated per attempt, stored server-side and single use, so a
callback cannot be replayed. The `state` is *also* pinned to a short-lived
`HttpOnly` cookie set when the flow starts, so only the browser that began a
sign-in can finish it — holding a valid code is not enough to land somebody
else in an account. The code is exchanged over a back channel with the client
secret. The ID token's signature is verified against the provider's published
JWKS, and its issuer, audience, expiry, `email_verified` and nonce are all
checked. The email domain must be one you listed. By default
(`PLIP_REQUIRE_ROSTER=1`) the person must already be on a roster. The
post-sign-in redirect is parsed and its origin compared, not string-matched:
`/\evil.example` and `/<TAB>/evil.example` are the two strings a
`startsWith('//')` check lets through, and a browser treats both as another
site.

**Sessions.** A random id in a signed, `HttpOnly`, `Secure`, `SameSite=Lax`
cookie, pointing at a row in `auth_sessions`. The page cannot read it. Signing
out deletes the row, so the old cookie is dead immediately rather than at
expiry. Changing `PLIP_SESSION_SECRET` revokes every session at once.

**CSRF.** A cookie travels on requests another site can cause, so every write
from a cookie session must carry the `x-plip-csrf` token `/api/me` handed out.

**Roles and rosters.** Exactly the rules in [Who can see what](#who-can-see-what),
in the same `shared/access.mjs`, running over real identities. A roster
re-import removes enrolments that are no longer in the file, so a student who
left a class stops being visible to its teacher on the next sync.

**Pseudonymity, in the schema.** `users` holds the email address; every other
table holds a generated `stu_…` / `tea_…` id. An export of `events` identifies
nobody. The database `CHECK`s that a shareable event has a class, so the
contract's rule is a storage constraint and not only a code path.

**Audit.** Every teacher read of a class or a student is recorded with who,
what and when. A student can read their own access log at
`GET /api/students/:id/access-log` — who has looked at their work.

**Retention.** Applied on every read and write, not by a job that might not
run, plus an hourly sweep. `PLIP_RETENTION_DAYS` is the whole policy.

**Headers and limits.** A content security policy with `script-src 'self'`
(there is no third-party script, no CDN and no analytics on a page that renders
children's work), `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy:
same-origin`, HSTS over TLS, and `Permissions-Policy` that allows the
microphone (for dictation) and nothing else. Per-identity rate limits on reads
and writes. In production an unexpected error returns "Something went wrong on
the server" rather than a stack trace.

### What is still yours, and cannot be code

The software can be correct and the deployment still be wrong. These are not
things this repository can do for you:

| | What you have to do |
| --- | --- |
| TLS | terminate it, keep the certificate renewed, set `PLIP_TRUST_PROXY=1` behind the proxy so rate limiting sees real addresses |
| Encryption at rest | put `PLIP_DATABASE` on an encrypted volume. SQLite does not encrypt itself |
| Backups | back the file up, test a restore, and know that "delete my data" has to reach the backups too or it is not deletion |
| Monitoring | `/api/health` is there; alerting on it is yours |
| The audit trail | it is written, but reading it, retaining it and acting on it is a human process |
| Curriculum | `PLIP_CATALOGUE` is your tasks and your concept ids. Four synthetic maths questions are not a syllabus |
| Roster sync | the CSV import is a starting point. Point your OneRoster, Clever or ClassLink export at `replaceRoster` and run it on a schedule |
| Scale | one SQLite file suits a school. Past that, swap `SqliteStore` for a Postgres one behind the same interface — `shared/` and `server/app.mjs` do not change |
| The agreement | a DPA with your vendor, a notice to parents, a named data owner, and the decisions in [Consent, FERPA and COPPA](#consent-ferpa-and-coppa) |

### If you add a model

The tutor is scripted and local on purpose, so a Chromebook needs no account
and the bundle needs no key. If you ever want a real one: put it behind
`POST /api/tutor` on your own server, taking `{ taskId, hintIndex,
attemptCount }` and returning a hint string. The student's words stay on the
device. **No API key ever goes into the bundle** — a key shipped to a browser
is a published key — and whatever the model is told becomes something your DPA
has to cover.

## Tests

```bash
cd apps/education
npm run check  # everything below, in order
npm test       # 88 assertions, then 27 of them again against SQLite
npm run e2e    # 18 browser flows against the demo, 8 against production
```

`npm test` runs the whole API suite twice — once against the in-memory store
the demo uses and once against the SQLite store production uses — because "the
demo enforces it" would mean nothing if the real backend did not.

It covers:

- **`tests/contract.test.mjs`** — the schema file on disk is the one the code
  validates against; every event type builds; `screenshot`, `url`, `transcript`,
  `prompt`, `keystrokes`, `email` and friends are refused; an email address is
  refused as a `studentId`; sharing without a class is refused; the factory
  never attaches a class to unshared work; the tiny schema checker itself.
- **`tests/access.test.mjs`** — role separation both ways; a teacher reaching
  only their own class; a missing class and someone else's class giving the same
  answer; a forged identity still refused; roster membership; a student only
  touching their own work; eligibility needing opt-in *and* class *and* roster;
  a student on two rosters keeping the classes apart.
- **`tests/summary.test.mjs`** — measured counts matching the events; concept
  evidence; the suggestion thresholds in both directions; unknowns stated rather
  than filled in; every suggestion carrying its basis; no summary ever claiming
  attention, mastery or a grade; the disclaimers naming them anyway; a teacher
  view told nothing about private work while the student's own view counts it;
  an empty summary saying so; retention.
- **`tests/api.test.mjs`** — all of the above over HTTP, plus the pause gate,
  revoking sharing retroactively, duplicate events, export, delete, the demo
  stamp on every response, a plain 404, and malformed and oversized bodies.
  Run against both stores.
- **`tests/production.test.mjs`** — the production path. Every startup guard
  refusing in turn; the fixtures unreadable with `PLIP_MODE=production`; a full
  OpenID Connect sign-in against a provider in `tests/fake-idp.mjs` that
  generates a real RSA key, publishes a real JWKS and really signs its tokens —
  and the same sign-in refused when the token is signed with another key, is
  stale, names the wrong issuer or audience, carries a replayed nonce or no
  email; a used callback refused the second time; a tampered or forged cookie
  refused; sign-out killing the session server-side; CSRF required on writes;
  the domain allowlist; the roster requirement; a student dropped from a class
  disappearing on the next sync; work surviving a restart and retention still
  clearing it; rate limiting; the security headers; an internal error not
  reaching the browser; and the CSV reader, including the files it refuses.

`npm run e2e` drives the built PWA in Chromium, each flow against its own
fresh API so no test's work shows up in another's numbers: nothing recorded
before opt-in, sharing needing a class code, a session producing exactly the six
listed event types and no banned field, the student preview matching the teacher
view, pause recording nothing, ending a paused session still recording that it
ended, revoking sharing emptying the teacher's summary, a session appearing in
the right teacher's dashboard, measured/unknown/suggested kept apart on the
page, one teacher not seeing another's class (including for a student on both
rosters), export and delete, the manifest and service worker, speech-to-text
present and taken away, a 600px-wide window with no overflow, the hint ladder
not leaking the answer, and the companion answering "what do you record about
me?".

`tests/e2e-production.mjs` does it again against a **production** server —
SQLite, school sign-in, no fixtures — with the browser clicking through the
real redirect to the identity provider and back: no demo banner and no fixture
list anywhere, a cookie the page cannot read, a whole session with CSRF on
every write, the teacher seeing the work by roster name while the events stay
pseudonymous, sign-out surviving a reload, an out-of-domain account and an
off-roster account each turned away in words a child could read, and the app
still installable with `script-src 'self'`.

### Platform tests still needed

Everything above runs on macOS and in Linux CI, against a fake identity
provider and over plain http on localhost. These need the real thing, and none
of them has been done:

- **A real Google Workspace for Education tenant**: a real OAuth client, real
  consent screen, real `hd`/domain behaviour, and a real student account. The
  client is verified against Google's published discovery document, but no
  token from Google has ever been exchanged.
- **Real TLS**: `Secure` cookies, HSTS, and a service worker installing over
  https rather than localhost.
- **A managed Chromebook**, enrolled, non-developer mode: install from the
  address bar, launcher and shelf icon, offline start, and behaviour after
  sign-out on a shared device.
- **`WebAppInstallForceList`** actually force-installing it from an Admin
  Console, and the app working with site data restricted.
- **ChromeOS dictation**: `webkitSpeechRecognition` with the mic allowed, with
  it denied, and with `AudioCaptureAllowed` off by policy. The code paths exist
  and are unit-reachable, but no CI browser has speech recognition, so the
  success path is untested on a real device.
- **`speechSynthesis`** voices on ChromeOS, including a profile with none
  installed.
- **School wifi drop-out**: the offline queue across a real suspend/resume and a
  captive portal.
- **Touch and tablet mode** on a convertible, and a 1366×768 screen at the
  browser's larger default font sizes.
- **ChromeOS screen reader (ChromeVox)** over the session controls and the
  dashboard tables.
- **A real roster at size**: a 30-student class, and a teacher with six
  classes. Nothing here has been run against more than five invented people,
  and no load test exists.
- **A restore**: the backup story is written down and has never been
  rehearsed on this schema.
- **The Docker image**: the Dockerfile is written and its layout is verified
  (the contract resolves from `/srv/contracts`), but no image has been built
  or run.

## Getting an extension onto a Chromebook

This app is a PWA and needs none of what follows — that is the point of it
being a PWA. But `apps/extension` is a browser extension, and a Chromebook
cannot just be handed one. Here is the honest shape of it, because it decides
which surface a school can actually roll out.

First, two different things are both called developer mode:

- **Extensions developer mode** — the toggle at the top of `chrome://extensions`.
  A browser setting. This is the one "Load unpacked" needs.
- **ChromeOS developer mode** — a firmware state that disables verified boot and
  powerwashes the device. Nothing here needs it, and no school should put a
  student device in it.

### 1. Load unpacked — development only

On a **personal, unenrolled** Chromebook: `chrome://extensions` → Developer
mode on → **Load unpacked** → pick the folder (keep it in *My Files*; the
picker will show Drive, but the loader wants real local files).

Three reasons this is not a deployment:

- A **managed** Chromebook can refuse it. `ExtensionDeveloperModeSettings=1`
  (Chrome 128+) stops a user turning developer mode on at all; with that policy
  unset, `DeveloperToolsAvailability=2` does the same thing. In a school
  tenant, one or both is usually already set.
- Chrome nags about unpacked extensions on every start, and the extension dies
  if the folder moves or is deleted.
- On a shared or ephemeral-mode Chromebook the profile is wiped at sign-out, so
  it is gone before the next lesson.

Use it to develop. Do not plan a rollout around it.

### 2. Admin Console force-install — what a school actually does

Google Admin Console → **Devices → Chrome → Apps & extensions → Users &
browsers**, scoped to an org unit or a group, set to **Force install**. The
extension appears on every signed-in managed device and the student cannot
remove it. (There is a ceiling of 500 for apps × groups.)

Two ways to point it at your extension:

**a. Chrome Web Store, private to your domain.** Publish with **Private**
visibility and it is visible only inside your Workspace organisation's own
Chrome Web Store — users have to be signed in with their school account to see
it. Costs a one-time **$5** developer registration fee, which is now charged
even for domain-private and trusted-tester extensions. This is the least
fragile route: Google hosts it, updates propagate normally.

**b. Self-hosted.** Pack a `.crx` (`chrome://extensions` → **Pack extension**,
or `chrome --pack-extension=DIR --pack-extension-key=key.pem`) and serve it
over HTTPS next to an update manifest:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
  <app appid="EXTENSION_ID_FROM_THE_KEY">
    <updatecheck codebase="https://plip.school.example/ext/plip-1.0.0.crx" version="1.0.0" />
  </app>
</gupdate>
```

Then give the Admin Console `EXTENSION_ID;https://plip.school.example/ext/update.xml`.
Keep `key.pem` — the extension id is derived from it, and losing it means a new
id and a re-deploy to every device. **Guard it like a signing key; it does not
belong in this repository.**

### What this means for us

| | the PWA (`apps/education`) | the extension (`apps/extension`) |
| --- | --- | --- |
| To put it on a Chromebook | open a URL; optionally "Install page as app" | an admin force-installs it, or nothing happens |
| Needs an admin | no | **yes**, every time |
| Needs the Chrome Web Store or a CRX host | no | yes |
| Survives an ephemeral-profile sign-out | yes (it is a URL) | only if force-installed by policy |
| Updates | refresh the page | Web Store, or your update manifest |

So the PWA is the surface a school can try on a Tuesday, and the extension is
the one that needs a change request. That is an argument for the extension
staying an *addition* to the web app rather than the way in — and for it
emitting the same learning events through the same contract, so a school that
only ever deploys the PWA loses no part of the teacher summary. See
[Sending events from the extension](#sending-events-from-the-extension-or-the-desktop-build).

One more constraint worth stating: new Chrome Web Store submissions must be
**Manifest V3**. Anything still on MV2 will not be accepted.

## Not duplicating the extension

`apps/extension` is a separate product surface, now in the tree. The line
between them:

| | this app (`apps/education`) | the extension (`apps/extension`) |
| --- | --- | --- |
| What it is | the place the student works: tasks, companion, session controls | a browser-level helper beside work happening elsewhere |
| Owns | the event contract, the demo API, the teacher dashboard, the summary logic | its own capture surface and its own consent UI |
| Does not own | anything under `apps/extension` | the contract, the API, the dashboard, the summary |
| Shared | `contracts/learning-event.schema.json`, and `apps/education/shared/*.mjs` if useful | — |

The extension emits events with `platform: "extension"` and leaves the
summarising to `shared/summary.mjs`. When the two surfaces disagreed about what
an outcome is — the extension recorded `unknown` and `abandoned`, neither of
which the schema had — it was settled in the contract and in both producers, not
by two dashboards that count differently. `abandoned` is now in the enum, and
`unknown` became *omitting* the field. The interop tests exist so the next
disagreement fails the build instead of a request.
