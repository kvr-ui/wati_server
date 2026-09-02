# NR DRIP — known issues, risks and unfinished work

Written 2 Sep 2026, after building and live-testing the drip against the real Bigin flow.

Everything below is something genuinely wrong, unfinished, or that behaves in a way you would
not expect. Nothing is speculative — each item names the code that causes it.

## Severity

| Rating | Means |
|---|---|
| **CRITICAL** | Losing leads or messaging the wrong people **right now**, or the moment you deploy. Fix before going live. |
| **HIGH** | Will bite under normal operation. Not firing today only because of how you happen to be using it. |
| **MEDIUM** | Real, but needs a specific trigger — another integration, an unusual record, an attacker. |
| **LOW** | Cosmetic, wasteful, or only affects reporting. |
| **FIXED** | Was a bug; now resolved and tested. Kept for the record. |

### At a glance

| # | Issue | Rating |
|---|---|---|
| 1.1 | `re_nurture` placeholder really sends to real leads | **CRITICAL** |
| 1.2 | Unset `NR_DRIP_NR_OUTCOMES` silently cancels everything | **CRITICAL** |
| 1.3 | A step with no template kills the lead permanently | **HIGH** |
| 1.4 | A failed send burns all three retries in one second | **HIGH** |
| 1.5 | Lead tagged NR **and** a closing tag still gets chased | **HIGH** |
| 1.6 | The webhook is unauthenticated | **HIGH** |
| 2.1 | Any payload without a `Tag` field cancels an active drip | **MEDIUM** |
| 2.2 | Everything returns 200, so a broken flow looks healthy | **MEDIUM** |
| 2.3 | A 10-digit foreign number becomes an Indian one | **MEDIUM** |
| 2.4 | No `campaign` field blocks the other tag drips | **MEDIUM** |
| 3.1 | Quiet hours squeeze the gap between messages | **LOW** |
| 3.2 | `callAttempts` over-counts | **LOW** |
| 3.3 | One WATI call per lead per step | **LOW** |
| 3.4 | Misc: wasted lookup, misnamed var, IST for overseas leads, tracked buildinfo | **LOW** |
| 4.1 | Re-enrolment cooldown measured from the wrong timestamp | **FIXED** |

---

## 1. Critical and high

### 1.1 `re_nurture` is a placeholder that really sends — **CRITICAL**

`NR_DRIP_TEMPLATE_2=re_nurture` is wired as the Day 1 message. It is a real approved template
about the Jan 2027 batch, not a test message. **Every real lead tagged `NR` gets it 24 hours
after `nr_bigin`** until you replace it.

*Fix:* set `NR_DRIP_TEMPLATE_2` to your real Day 1 template, or set `NR_DRIP_STEP_OFFSETS=0` so
the drip is one message until it is ready.

### 1.2 An unset `NR_DRIP_NR_OUTCOMES` cancels everything and enrols nothing — **CRITICAL**

If that variable is missing or empty on the server, `isNoResponseOutcome()` returns false for
**every** tag. Every webhook then reads as "lead is no longer NR", so:

- no lead is ever enrolled, and
- every existing drip is cancelled on the next tag change.

There is no warning. The system looks alive — 200s, clean logs — and quietly does nothing.

This is the most likely production failure, because `.env` is gitignored: these keys must be
re-typed by hand on the server, which is exactly when one gets missed.

*Fix:* log a loud warning at startup when `NR_DRIP_ENABLED=true` and the outcome list is empty.

### 1.3 A step with no template kills the lead permanently — **HIGH**

A step with no `NR_DRIP_TEMPLATE_n` parks the lead in `window_closed`, a **terminal** state.
They do not resume when you add the template later — that lead is finished.

This is why the cadence is `0,24` and not `0,24,72`. **Do not add a step to
`NR_DRIP_STEP_OFFSETS` before its template exists.**

*Fix:* treat a missing template as "skip to the next step" rather than a terminal park.

### 1.4 A failed send burns all three retries in about one second — **HIGH**

The runner's batch loop re-reads the `due` queue every iteration. A definitive failure puts the
lead straight back to `state: 'due'` with its **original** `dueAt` — already in the past — so
the next loop iteration claims it again.

```
attempt 1 fails → back to due → attempt 2 fails → back to due → attempt 3 → failed
```

All three land inside one cron run, ~`NR_DRIP_SEND_GAP_MS` (400 ms) apart. The code comment
says "returned to the queue for the next tick", which is not what happens.

The retry was meant to ride out a transient WATI problem. As written, a 30-second WATI blip
permanently parks the lead as `failed` instead of retrying 15 minutes later.

*Fix:* push `dueAt` forward on a retry (`now + backoff`) instead of leaving it in the past.

### 1.5 A lead tagged NR **and** a closing tag still gets chased — **HIGH**

`isNoResponseOutcome()` returns true if **any** tag matches the NR list. Bigin sends every tag
on the contact, so one carrying both arrives as `"NR,CWOS"` and enrols — though CWOS means the
lead is closed.

```
Tag: [{NR}, {CWOS}]  →  outcome "NR,CWOS"  →  some() matches "nr"  →  ENROLLED
```

This cannot happen while a contact only ever carries one tag, which is how you use Bigin today.
Nothing enforces that.

*Fix:* add `NR_DRIP_STOP_OUTCOMES=CWOS,Connected,…` checked **before** the NR list, so a stop
tag wins over a co-present NR tag.

### 1.6 The webhook is unauthenticated — **HIGH**

By your decision, and the reasoning holds — but the consequence belongs on the record. Anyone
who learns the URL can enrol any phone number into a WhatsApp drip on your WATI account, or
cancel drips (§2.1). The realistic damage is not the bill; it is your business number being
reported and quality-limited by Meta.

What limits it today is entirely downstream: `NR_DRIP_ENABLED`, `NR_DRIP_MAX_CANDIDATES=200`,
and the re-enrol cooldown.

*Fix if the URL leaks:* nginx `allow`/`deny` on that path using Zoho's published IP ranges.

---

## 2. Medium

### 2.1 Any payload without a `Tag` field cancels an active drip — **MEDIUM**

The webhook treats a missing or empty tag as "NR tag removed" and cancels. Correct for your
current flow, which always sends `Tag`. But any other Zoho flow, integration or manual test that
posts here without a `Tag` field silently stops a running drip.

With §1.6, anyone who learns the URL can cancel every drip by posting `{"Phone":"91…"}`.

*Fix:* distinguish "Tag key present but empty" (a real removal) from "Tag key absent" (an
unrelated payload — ignore).

### 2.2 Everything returns 200, so a broken flow looks healthy — **MEDIUM**

By your request, the webhook never fails. A flow with the wrong field mapped — no phone ever
arriving — reports success on every run. The truth is in the response **body**
(`"action":"ignored"`, `detail`, `receivedKeys`), not the status code.

`"action":"enrolled"` is the only response meaning a drip actually started.

### 2.3 A 10-digit foreign number becomes an Indian one — **MEDIUM**

`normalizePhone()` prepends `DEFAULT_COUNTRY_CODE=91` to any 10-digit number. You have overseas
leads — a Bangladeshi contact came through during testing. That one was fine because it arrived
as `+880…`, but a 10-digit number stored without its country code is silently turned into a
different, valid Indian number, and the message goes to a stranger.

### 2.4 No `campaign` field blocks the other tag drips — **MEDIUM**

`nr_drip` holds one record per phone with nothing saying which campaign it is. Fine while NR is
the only drip. The moment a second tag gets its own sequence, records collide on the phone key
and the campaigns cannot be told apart.

Cheap now while the collection is empty; a data migration once production data exists.

---

## 3. Low

### 3.1 Quiet hours squeeze the gap between messages

Each step's `dueAt` comes from `enrolledAt`, not from when the previous message actually went
out, so a step delayed by quiet hours lands closer to the next one.

```
22:00 Mon  tagged NR, step 1 due → held (quiet hours)
09:00 Tue  step 1 sends           ← 11h late
22:00 Tue  step 2 due             → held
09:00 Wed  step 2 sends           ← lead experienced a 24h gap, not the intended 48h
```

Absolute scheduling is deliberate — it stops a paused cron compressing the whole sequence — but
the *felt* gap varies with enrolment time.

### 3.2 `callAttempts` over-counts

Zoho retries and repeated tag changes each increment it. It is not a reliable count of how many
times sales actually phoned. Do not report on it as one.

### 3.3 One WATI API call per lead per step

The reply check calls `getMessages` before every send. At batch 25 that is 25 extra calls per
run; watch WATI's rate limits as volume grows.

### 3.4 Miscellaneous

- **A wasted lookup on template-only steps.** `sendNrDripStep` checks the 24h session window
  even when no session copy is configured, so the result is never used.
- **Quiet hours are IST for everyone**, including overseas leads.
- **`NR_DRIP_CANCEL_ON_CONNECTED` is misnamed** — it controls cancelling on *any* tag change.
- **`tsconfig.tsbuildinfo` is tracked in git** and shows modified on every build. Predates this
  work; belongs in `.gitignore`.

---

## 4. Fixed

### 4.1 Re-enrolment cooldown measured from the wrong timestamp — **FIXED**

The cooldown was measured from `enrolledAt` rather than from when the drip ended, and applied
even to a drip that had sent nothing. Two opposite failures came out of that:

**Locked a lead out for a week.** A tag applied and taken straight off again still blocked
re-enrolment for the full 168 hours, so sales re-tagging saw nothing happen.

```
10:00  tagged NR              → enrolled
10:01  tag removed by mistake → cancelled
10:02  tagged NR again        → cooldown   ← no drip for 7 days
```

**And messaged a lead too soon.** The inverse: a long drip enrolled 8 days ago but ended 2 hours
ago passed the check (8 days > 7) and re-enrolled — sending a second message two hours after
the first.

Now the cooldown runs from when the drip actually ended (`cancelledAt`, else `completedAt`, else
the last message sent), and is skipped entirely when the previous drip sent nothing — a drip
that messaged nobody cannot have been too much contact. Once a message has gone out the cooldown
applies normally, so repeated tagging still cannot spam anyone.

Verified: un-sent drip re-tagged → `reenrolled`; sent drip re-tagged → `cooldown`; drip enrolled
8 days ago but ended 2 hours ago → `cooldown`.

---

## 5. Not done yet

| | |
|---|---|
| Day 1 template | you are supplying it; `re_nurture` is standing in (§1.1) |
| Day 3 template | not supplied; cadence held at `0,24` until it exists (§1.3) |
| Other tag campaigns | not built; needs the `campaign` field first (§2.4) |
| Deployment | nothing is on the server — no `nrdrip/`, no routes |
| Production indexes | `node nrdrip/ensure-indexes.mjs` not yet run on Atlas |
| Production env | `.env` is gitignored; all `NR_DRIP_*` keys must be re-entered by hand |
| Production cron | the 15-minute cron line is not installed |
| Zoho URL | still points at a dead tunnel; needs the production URL |
| Automated tests | none — everything verified by hand against live Bigin |

---

## 6. Deliberate choices, not bugs

Listed so nobody "fixes" them later:

- **Any non-NR tag cancels the drip.** Each tag owns its own campaign; a lead who moves tags
  belongs to the new one. Confirmed as intended.
- **CWOS cancels.** It means closed-without-sale.
- **An ambiguous send outcome parks the lead rather than retrying.** A duplicate WhatsApp
  message is worse than a missed one.
- **Contact ids are not used for replay detection.** `${trigger.id}` is identical on every
  webhook about a person; using it swallowed the "sales connected" webhook and left drips
  running. Idempotency comes from the state machine instead.
- **`CA_Status` is ignored.** It holds the course level ("Intermediate"), not a call result.
- **The runner refuses to send when candidates exceed `NR_DRIP_MAX_CANDIDATES`.** A silent
  no-op is the right response to a suspicious spike.
