# NR DRIP — known issues, risks and unfinished work

Written 2 Sep 2026, after building and live-testing the drip against the real Bigin flow, then
revised once the bugs found in that review were fixed.

Everything below is genuinely wrong, unfinished, or behaves in a way you would not expect.
Nothing is speculative — each item names the code that causes it.

## Severity

| Rating | Means |
|---|---|
| **CRITICAL** | Losing leads or messaging the wrong people **right now**, or the moment you deploy. |
| **HIGH** | Will bite under normal operation. Not firing today only because of how you happen to be using it. |
| **MEDIUM** | Real, but needs a specific trigger — another integration, an unusual record, an attacker. |
| **LOW** | Cosmetic, wasteful, or only affects reporting. |
| **FIXED** | Was a bug; now resolved and tested. Kept for the record. |

### At a glance

Every CRITICAL and HIGH code bug is fixed. What remains open is either content you are still
supplying, or a decision you made deliberately.

| # | Issue | Rating |
|---|---|---|
| 1.1 | `re_nurture` placeholder really sends to real leads | **CRITICAL — open** |
| 1.2 | The webhook is unauthenticated | **HIGH — open by choice** |
| 2.1 | A 10-digit foreign number becomes an Indian one | **MEDIUM — open** |
| 2.2 | Everything returns 200, so a broken flow looks healthy | **MEDIUM — open by choice** |
| 3.1 | Quiet hours squeeze the gap between messages | **LOW — by design** |
| 3.2 | `callAttempts` over-counts | **LOW — open** |
| 3.3 | One WATI call per lead per step | **LOW — open** |
| 3.4 | Quiet hours are IST for overseas leads too | **LOW — open** |
| 4.1 | Re-enrolment cooldown measured from the wrong timestamp | **FIXED** |
| 4.2 | Unset `NR_DRIP_NR_OUTCOMES` silently cancelled everything | **FIXED** |
| 4.3 | A step with no template killed the lead permanently | **FIXED** |
| 4.4 | A failed send burned all three retries in one second | **FIXED** |
| 4.5 | A lead tagged NR **and** a closing tag still got chased | **FIXED** |
| 4.6 | A payload with no `Tag` field cancelled an active drip | **FIXED** |
| 4.7 | No `campaign` field blocked the other tag drips | **FIXED** |
| 4.8 | Wasted session lookup, misnamed variable, tracked build artifact | **FIXED** |

---

## 1. Still open — needs you

### 1.1 `re_nurture` is a placeholder that really sends — **CRITICAL**

`NR_DRIP_TEMPLATE_2=re_nurture` is wired as the Day 1 message. It is a real approved template
about the Jan 2027 batch, not a test message. **Every real lead tagged `NR` gets it 24 hours
after `nr_bigin`** until you replace it.

Not a code bug — it is the placeholder you asked for while your Day 1 template is being created.
It is listed CRITICAL because it is the one thing here that messages real people with copy you
did not choose for this purpose.

*Closes when:* you send the Day 1 template name and it replaces `NR_DRIP_TEMPLATE_2`. Or set
`NR_DRIP_STEP_OFFSETS=0` and the drip is one message until then.

### 1.2 The webhook is unauthenticated — **HIGH, open by your decision**

Anyone who learns the URL can enrol any phone number into a WhatsApp drip on your WATI account.
The realistic damage is not the bill; it is your business number being reported and
quality-limited by Meta.

What limits it is entirely downstream: `NR_DRIP_ENABLED`, `NR_DRIP_MAX_CANDIDATES=200`, and the
re-enrol cooldown. Since §4.6, a stranger can no longer *cancel* drips by posting a tagless
payload — only enrol.

*Fix if the URL ever leaks:* nginx `allow`/`deny` on that path using Zoho's published IP ranges.

---

## 2. Still open — medium

### 2.1 A 10-digit foreign number becomes an Indian one — **MEDIUM**

`normalizePhone()` prepends `DEFAULT_COUNTRY_CODE=91` to any 10-digit number. You have overseas
leads — a Bangladeshi contact came through during testing. That one was fine because it arrived
as `+880…`, but a 10-digit number stored without its country code is silently turned into a
different, valid Indian number, and the message goes to a stranger.

**Deliberately not fixed.** `normalizePhone` is shared with the whole VSL system — link sending,
lead resolution, reminders — and a 10-digit number genuinely is Indian in the overwhelming
majority of your data. Changing the rule would alter behaviour well outside NR DRIP, which is
not something to do blind.

*Real fix:* make sure Bigin stores every contact with its country code, which is a data-quality
job rather than a code one.

### 2.2 Everything returns 200, so a broken flow looks healthy — **MEDIUM, by your decision**

The webhook never fails, so Zoho never marks a run failed. A flow with the wrong field mapped —
no phone ever arriving — reports success every time. The truth is in the response **body**
(`"action"`, `detail`, `receivedKeys`), not the status code.

`"action":"enrolled"` is the only response that means a drip actually started.

---

## 3. Still open — low

### 3.1 Quiet hours squeeze the gap between messages — **by design**

Each step's `dueAt` comes from `enrolledAt`, not from when the previous message went out, so a
step delayed by quiet hours lands closer to the next one.

```
22:00 Mon  tagged NR, step 1 due → held (quiet hours)
09:00 Tue  step 1 sends           ← 11h late
22:00 Tue  step 2 due             → held
09:00 Wed  step 2 sends           ← lead experienced 24h, not the intended 48h
```

Absolute scheduling is deliberate — it stops a paused cron compressing the whole sequence — so
this is the accepted cost, not an oversight.

### 3.2 `callAttempts` over-counts

Zoho retries and repeated tag changes each increment it. It is not a reliable count of how many
times sales actually phoned. Do not report on it as one.

### 3.3 One WATI API call per lead per step

The reply check calls `getMessages` before every send. At batch 25 that is 25 extra calls per
run. Necessary — it is how a reply cancels the drip — but watch WATI's rate limits as volume
grows.

### 3.4 Quiet hours are IST for everyone

Including overseas leads. There is no per-lead timezone in the data to do better.

---

## 4. Fixed

### 4.1 Re-enrolment cooldown measured from the wrong timestamp — **FIXED**

Measured from `enrolledAt` rather than from when the drip ended, and applied even to a drip that
had sent nothing. Two opposite failures came out of that.

**Locked a lead out for a week.** A tag applied and taken straight off again still blocked
re-enrolment for the full 168 hours, so sales re-tagging saw nothing happen.

```
10:00  tagged NR              → enrolled
10:01  tag removed by mistake → cancelled
10:02  tagged NR again        → cooldown   ← no drip for 7 days
```

**And messaged a lead too soon.** The inverse: a drip enrolled 8 days ago but ended 2 hours ago
passed the check (8 days > 7) and re-enrolled — a second message two hours after the first.

Now the cooldown runs from when the drip actually ended (`cancelledAt`, else `completedAt`, else
the last message sent), and is skipped entirely when the previous drip sent nothing — a drip
that messaged nobody cannot have been too much contact. Once a message has gone out it applies
normally, so repeated tagging still cannot spam anyone.

*Verified:* un-sent drip re-tagged → `reenrolled`; sent drip re-tagged → `cooldown`; enrolled 8
days ago but ended 2 hours ago → `cooldown`.

### 4.2 An unset `NR_DRIP_NR_OUTCOMES` cancelled everything — **FIXED**

With that variable empty, every tag looked like "no longer NR": nothing was ever enrolled, and
every running drip was cancelled on the next tag change — silently, with clean logs and 200s.
The most likely production failure, since `.env` is gitignored and the keys are retyped by hand
at deploy.

The webhook now checks `nrOutcomesConfigured()` and refuses to enrol **or** cancel anything,
logging a loud error instead.

*Verified:* with the list empty, an active drip survived a `Connected` webhook and the error was
logged.

### 4.3 A step with no template killed the lead permanently — **FIXED**

An unconfigured step parked the lead in `window_closed`, a terminal state they never recovered
from — even once the template existed.

`sendNrDripStep` now returns `notConfigured`, and the runner advances the lead to the next step
instead of parking them. A step whose template has not been created yet can no longer end
someone's sequence, so adding a step before its template is safe.

*Verified:* with step 2's template unset, a lead got step 1 then `skipped-not-configured`, and
finished `completed` rather than `window_closed`.

### 4.4 A failed send burned all three retries in one second — **FIXED**

A definitive failure put the lead back to `due` with its original, already-past `dueAt`, so the
same batch loop re-claimed it on the next iteration. All three attempts landed ~400 ms apart
inside one cron run, meaning a brief WATI outage permanently parked the lead as `failed`.

Retries now push `dueAt` forward by `NR_DRIP_RETRY_BACKOFF_MINUTES` (default 15) multiplied by
the attempt number, so each attempt lands on a later cron tick.

*Verified:* a deliberately invalid template produced one attempt with `dueAt` ~15 minutes out
and `state: due`, where it previously produced three attempts and `failed`.

### 4.5 A lead tagged NR **and** a closing tag still got chased — **FIXED**

`isNoResponseOutcome()` returned true if any tag matched, so a contact arriving as `"NR,CWOS"`
enrolled despite being closed.

`NR_DRIP_STOP_OUTCOMES` (set to `CWOS`) is now checked **first** and overrides the NR match.
Descriptive tags are unaffected — `"Hot Lead,NR"` still enrols, because only outcome tags belong
in the stop list.

*Add your remaining outcome tags to `NR_DRIP_STOP_OUTCOMES` as they are confirmed.*

*Verified:* `NR,CWOS` → not enrolled; `Hot Lead,NR` → enrolled.

### 4.6 A payload with no `Tag` field cancelled an active drip — **FIXED**

The webhook treated a missing tag the same as a removed one, so any other integration posting
here without a `Tag` field silently stopped a running drip — and with §1.2, so could a stranger.

It now distinguishes "`Tag` key present but empty" (a real removal — still cancels, as you
wanted) from "`Tag` key absent" (an unrelated payload — ignored).

*Verified:* payload with no `Tag` key → `ignored`; payload with `Tag: []` → `cancelled`.

### 4.7 No `campaign` field blocked the other tag drips — **FIXED**

Records now carry `campaign: 'nr'`, with a `(campaign, state)` index and a backfill in
`ensure-indexes.mjs` for anything written earlier. The other Bigin tags can have their own
sequences in this collection without their leads being confused for NR ones.

### 4.8 Wasted lookup, misnamed variable, tracked build artifact — **FIXED**

- The 24h session-window lookup only runs when there is session copy that could use it. A
  template-only step no longer makes an API call whose answer it ignores.
- `NR_DRIP_CANCEL_ON_CONNECTED` is now `NR_DRIP_CANCEL_ON_TAG_CHANGE`, which is what it does.
  The old name is still honoured.
- `tsconfig.tsbuildinfo` is untracked and gitignored.

---

## 5. Not done yet

| | |
|---|---|
| Day 1 template | you are supplying it; `re_nurture` is standing in (§1.1) |
| Day 3 template | not supplied; cadence held at `0,24` until it exists |
| Remaining stop tags | only `CWOS` is in `NR_DRIP_STOP_OUTCOMES`; add the others when confirmed (§4.5) |
| Other tag campaigns | not built; the `campaign` field is now in place for them (§4.7) |
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
- **Removing the NR tag cancels the drip.** The chase only runs while the lead is still marked.
- **An ambiguous send outcome parks the lead rather than retrying.** A duplicate WhatsApp
  message is worse than a missed one.
- **Contact ids are not used for replay detection.** `${trigger.id}` is identical on every
  webhook about a person; using it swallowed the "sales connected" webhook and left drips
  running. Idempotency comes from the state machine instead.
- **`CA_Status` is ignored.** It holds the course level ("Intermediate"), not a call result.
- **The runner refuses to send when candidates exceed `NR_DRIP_MAX_CANDIDATES`.** A silent
  no-op is the right response to a suspicious spike.
