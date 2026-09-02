# NR DRIP — known issues, risks and unfinished work

Written 2 Sep 2026, after building and live-testing the drip against the real Bigin flow.

Everything below is something that is genuinely wrong, unfinished, or will behave in a way you
would not expect. Sorted by how likely it is to cost you leads or money. Nothing here is
speculative — each item names the code that causes it.

---

## 1. Will cause a problem in production

### 1.1 `re_nurture` is a placeholder that really sends

`NR_DRIP_TEMPLATE_2=re_nurture` is wired as the Day 1 message. It is a real approved template
about the Jan 2027 batch — not a "test" message. **Every real lead tagged `NR` gets it 24 hours
after `nr_bigin`** until you replace it.

*Fix:* set `NR_DRIP_TEMPLATE_2` to your real Day 1 template, or set
`NR_DRIP_STEP_OFFSETS=0` so the drip is one message until it is ready.

### 1.2 A lead tagged NR **and** a closing tag still gets chased

`isNoResponseOutcome()` in `config.ts` returns true if **any** tag matches the NR list. Bigin
sends every tag on the contact, so a contact carrying both tags arrives as `"NR,CWOS"` and
enrols — even though CWOS means the lead is closed.

```
Tag: [{NR}, {CWOS}]  →  outcome "NR,CWOS"  →  some() matches "nr"  →  ENROLLED
```

This is the tag equivalent of chasing someone you have already written off. It cannot happen
while a contact only ever carries one tag, which is how you are using Bigin today — but nothing
enforces that.

*Fix:* add a stop-list (`NR_DRIP_STOP_OUTCOMES=CWOS,Connected,…`) checked **before** the NR
list, so any stop tag wins over a co-present NR tag.

### 1.3 A failed send burns all three retries in about one second

The runner's batch loop re-reads the `due` queue on every iteration. A definitive failure puts
the lead straight back to `state: 'due'` with its **original** `dueAt` — already in the past —
so the very next loop iteration claims it again.

```
attempt 1 fails → back to due → attempt 2 fails → back to due → attempt 3 → failed
```

All three happen inside one cron run, roughly `NR_DRIP_SEND_GAP_MS` (400 ms) apart. The
comment in the code says "returned to the queue for the next tick", which is not what happens.

The retry logic was meant to ride out a transient WATI problem. As written, a 30-second WATI
blip permanently parks the lead as `failed` instead of retrying 15 minutes later.

*Fix:* push `dueAt` forward on a retry (`now + backoff`) instead of leaving it in the past.

### 1.4 An accidental un-tag locks the lead out for 7 days

Re-enrolment cooldown is measured from `enrolledAt`, not from when the drip ended
(`enroll.ts`). So a drip that was cancelled seconds after starting still blocks re-enrolment
for the full `NR_DRIP_REENROLL_AFTER_HOURS` (default 168h = 7 days).

```
10:00  tagged NR        → enrolled
10:01  tag removed by mistake → cancelled
10:02  tagged NR again   → "cooldown"  ← no drip for 7 days
```

Sales will read that as "the automation is broken". The response body says `cooldown`, but
nobody is reading response bodies.

*Fix:* measure the cooldown from `cancelledAt`/`completedAt`, or skip it entirely when the
previous drip sent zero steps.

### 1.5 Any payload without a `Tag` field cancels an active drip

The webhook treats a missing or empty tag as "NR tag removed" and cancels. That is right for
your current flow, which always sends `Tag`. But if any other Zoho flow, integration or manual
test ever posts to this URL without a `Tag` field, it will silently stop a running drip.

Combined with §1.7 (no authentication), anyone who learns the URL can cancel every drip by
posting `{"Phone":"91…"}`.

*Fix:* distinguish "Tag key present but empty" (a real removal) from "Tag key absent"
(an unrelated payload — ignore).

### 1.6 An unset `NR_DRIP_NR_OUTCOMES` cancels everything and enrols nothing

If that variable is missing or empty on the server, `isNoResponseOutcome()` returns false for
**every** tag. Every webhook is then read as "lead is no longer NR", so:

- no lead is ever enrolled, and
- every existing drip is cancelled on the next tag change.

There is no warning. The system looks alive — 200s, clean logs — and quietly does nothing. This
is the single most likely production misconfiguration, because `.env` is gitignored and these
keys must be re-entered by hand on the server.

*Fix:* log a loud warning at startup when `NR_DRIP_ENABLED=true` and the outcome list is empty.

### 1.7 The webhook is unauthenticated

By your decision, and the reasoning holds — but the consequence should be written down. Anyone
who learns the URL can enrol any phone number into a WhatsApp drip on your WATI account, or
cancel drips (§1.5). The realistic damage is not the bill; it is your business number being
reported and quality-limited by Meta.

What limits it today is entirely downstream: `NR_DRIP_ENABLED`, `NR_DRIP_MAX_CANDIDATES=200`,
and the re-enrol cooldown.

*Fix if the URL leaks:* nginx `allow`/`deny` on that path using Zoho's published IP ranges.

---

## 2. Will surprise you

### 2.1 A step with no template kills the lead permanently

If a step has no `NR_DRIP_TEMPLATE_n`, the lead is parked in `window_closed` — a **terminal**
state. They do not resume when you add the template later; that lead is finished.

This is why the cadence is currently `0,24` and not `0,24,72`. **Do not add a step to
`NR_DRIP_STEP_OFFSETS` before its template exists.**

### 2.2 Quiet hours squeeze the gap between messages

Each step's `dueAt` is computed from `enrolledAt`, not from when the previous message actually
went out. A step delayed by quiet hours therefore lands closer to the next one.

```
22:00 Mon  tagged NR, step 1 due immediately → held (quiet hours)
09:00 Tue  step 1 sends                       ← 11h late
22:00 Tue  step 2 due                         → held
09:00 Wed  step 2 sends                       ← only 24h after step 1, but the
                                                lead experienced a 24h gap, not 48h
```

Absolute scheduling is deliberate — it stops a paused cron compressing the whole sequence — but
it means the *felt* gap between messages varies with enrolment time.

### 2.3 Everything returns 200, so a broken flow looks healthy

By your request, the webhook never fails. A flow with the wrong field mapped — no phone ever
arriving — reports success on every run. The truth is in the response **body**
(`"action":"ignored"`, `detail`, `receivedKeys`), not the status code.

`"action":"enrolled"` is the only response that means a drip actually started.

### 2.4 `callAttempts` over-counts

Zoho retries and repeated tag changes each increment `callAttempts`. It is not a reliable count
of how many times sales actually phoned the lead. Do not report on it as one.

### 2.5 A 10-digit foreign number becomes an Indian one

`normalizePhone()` prepends `DEFAULT_COUNTRY_CODE=91` to any 10-digit number. You have overseas
leads — a Bangladeshi contact came through during testing. That one was fine because it arrived
as `+880…`, but a 10-digit number stored without its country code will be silently turned into
a wrong Indian number, and the message goes to a stranger.

---

## 3. Worth knowing

- **One WATI API call per lead per step.** The reply check calls `getMessages` before every
  send. At batch 25 that is 25 extra calls per run; watch WATI's rate limits as volume grows.
- **A wasted lookup on template-only steps.** `sendNrDripStep` checks the 24h session window
  even when no session copy is configured, so the result is never used.
- **Quiet hours are IST for everyone**, including overseas leads.
- **`nr_drip` has no `campaign` field.** Fine while NR is the only drip. The moment a second tag
  gets its own sequence, records collide on the phone key and you cannot tell the campaigns
  apart. Cheap to add now, a migration once there is production data.
- **`NR_DRIP_CANCEL_ON_CONNECTED` is misnamed** — it controls cancelling on *any* tag change,
  not just "connected".
- **`tsconfig.tsbuildinfo` is tracked in git** and shows as modified on every build. It predates
  this work; it belongs in `.gitignore`.

---

## 4. Not done yet

| | |
|---|---|
| Day 1 template | you are supplying it; `re_nurture` is standing in (§1.1) |
| Day 3 template | not supplied; cadence held at `0,24` until it exists (§2.1) |
| Other tag campaigns | not built; needs the `campaign` field first (§3) |
| Deployment | nothing is on the server — no `nrdrip/`, no routes |
| Production indexes | `node nrdrip/ensure-indexes.mjs` has not been run on Atlas |
| Production env | `.env` is gitignored; all `NR_DRIP_*` keys must be re-entered by hand |
| Production cron | the 15-minute cron line is not installed |
| Zoho URL | still points at a dead tunnel; needs the production URL |
| Automated tests | none — everything was verified by hand against live Bigin |

---

## 5. Deliberate choices, not bugs

Listed so nobody "fixes" them later:

- **Any non-NR tag cancels the drip.** Each tag owns its own campaign; a lead who moves tags
  belongs to the new one. Confirmed as intended.
- **CWOS cancels.** It means closed-without-sale.
- **An ambiguous send outcome parks the lead rather than retrying.** A duplicate WhatsApp
  message is worse than a missed one.
- **Contact ids are not used for replay detection.** `${trigger.id}` is the same on every
  webhook about a person; using it swallowed the "sales connected" webhook and left drips
  running. Idempotency comes from the state machine instead.
- **`CA_Status` is ignored.** It holds the course level ("Intermediate"), not a call result.
- **The runner refuses to send when candidates exceed `NR_DRIP_MAX_CANDIDATES`.** A silent
  no-op is the correct response to a suspicious spike.
