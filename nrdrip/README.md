# NR DRIP

A WhatsApp drip for leads the sales team **could not reach**.

The VSL funnel ends when the lead watches the video and is handed to sales. If sales calls and
nobody answers, nothing used to happen. NR DRIP fills that gap: Bigin reports the call outcome,
and a lead tagged `NR` is enrolled in a three-message sequence over **Day 0 / 1 / 3** that
stops the moment they reply, are reached, or have the tag taken off.

**The engine is no longer in this folder.** The state machine, the send path and the webhook
decision tree live in [`dripcore/`](../dripcore) and are shared with every other tag campaign —
[`intermediatedrip/`](../intermediatedrip) today — so a bug fixed there is fixed for all of them.
What remains here is `campaign.ts` (the descriptor: `nr` / `nr_drip` / `NR_DRIP_` / its legacy env
aliases) and `index.ts` (dripcore bound to it).

dripcore reuses `lib/wati.ts` for sending, `lib/phone.ts` for normalisation, and the same
claim-before-send state machine as `lib/vslReminders.ts`.

## Before you switch it on

**Every step needs a Meta-approved WhatsApp template.** WATI free-form messages only work
within 24h of the lead's *last inbound message*. Day 1, 3 and 6 land well outside that. And the
cancel rule makes it near-circular: an open window means a recent inbound, which means the lead
replied, which cancels the drip. So the session-message path is opportunistic only — the
templates are what actually deliver. With `NR_DRIP_ENABLED=true` and no templates configured,
leads simply park as `window_closed`.

Get three templates approved and set `NR_DRIP_TEMPLATE_1..3`. Declare each template's real
variables with `NR_DRIP_TEMPLATE_PARAMS_n` — the default is `name`, and `none` is how a step
says the template takes no variables at all (as `re_nurture` does). Sending a variable a
template does not declare risks the message being rejected.

## Flow

```
Bigin call logged
      │
      ▼
POST /api/webhooks/bigin-call-outcome     (unauthenticated)
      │
      ├─ call id already seen ──────────────────► no-op (Zoho Flow replay)
      ├─ no tag at all (tag removed) ───────────► cancel active drip ("tag_removed")
      ├─ outcome not in NR_DRIP_NR_OUTCOMES ────► cancel active drip ("tag_changed")
      ├─ drip already active ───────────────────► record the extra attempt, keep the schedule
      ├─ finished within the re-enrol cooldown ─► no-op
      └─ otherwise ─────────────────────────────► enrol: state=due, step=0, dueAt=now
      │
      ▼
*/15 cron → POST /api/cron/nr-drip        (bearer CRON_SECRET)
      │
      ├─ claim atomically (due → claimed)
      ├─ lead replied since enrolledAt? ────────► cancelled ("replied")
      ├─ send step (session if window open, else template)
      └─ schedule the next step, or completed after the last one
```

Each step's `dueAt` is computed from `enrolledAt`, so a paused cron or a long quiet-hours gap
never compresses the sequence — steps land on their absolute schedule instead of bunching up.

## State machine

`due` → `claimed` → `due` (next step) → … → `completed`

Terminal states: `completed`, `cancelled` (replied / tag_changed / tag_removed / manual), `failed`
(known-undelivered, out of attempts), `unknown` (ambiguous send — parked, never auto-retried),
`window_closed` (no template for that step), `stuck` (claim stranded by a crash).

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `NR_DRIP_ENABLED` | `false` | Master switch. Nothing sends unless `true`. |
| `NR_DRIP_NR_OUTCOMES` | — | Comma-separated outcomes that mean "not reached", case-insensitive. Empty = nothing ever enrols. |
| `NR_DRIP_STOP_OUTCOMES` | — | Tags that end the chase even when NR is also present. A contact can carry several tags; without this a lead tagged `NR,CWOS` is still chased. Outcome tags only — never descriptive ones like `Hot Lead`. |
| `NR_DRIP_CANCEL_ON_TAG_CHANGE` | `true` | Any non-NR tag cancels an active drip. `false` = reply-only cancellation. (`NR_DRIP_CANCEL_ON_CONNECTED` is the old name, still honoured.) |
| `NR_DRIP_STEP_OFFSETS` | `0,24,72` | Hours from enrolment per step. Length sets the step count. A step with no template configured is skipped, and the lead moves on to the next one. |
| `NR_DRIP_STEP_OFFSETS_MINUTES` | — | Overrides the above. Testing only. |
| `NR_DRIP_MESSAGE_1..3` | — | Session copy per step. Leave empty to always use the template. Supports `{{name}}`, `{{url}}`, literal `\n`. |
| `NR_DRIP_TEMPLATE_1..3` | — | Approved template name per step. Required in practice. |
| `NR_DRIP_TEMPLATE_PARAMS_1..3` | `name` | Variables to send with that step's template. `none` for a template with no variables. |
| `NR_DRIP_URL` | the lead's VSL link | Where the copy points — usually a booking/callback page. |
| `NR_DRIP_REENROLL_AFTER_HOURS` | `168` | A finished drip cannot restart inside this window. |
| `NR_DRIP_QUIET_START_IST` | `21` | Quiet hours begin (Asia/Kolkata). |
| `NR_DRIP_QUIET_END_IST` | `9` | Quiet hours end. |
| `NR_DRIP_BATCH` | `25` | Max leads per run. |
| `NR_DRIP_SEND_GAP_MS` | `400` | Pause between sends. |
| `NR_DRIP_RETRY_BACKOFF_MINUTES` | `15` | How long a failed step waits before its next attempt, multiplied by the attempt number. |
| `NR_DRIP_MAX_CANDIDATES` | `200` | Circuit breaker — above this the run refuses to send at all. |
| `NR_DRIP_STALE_MINUTES` | `15` | Claim age before the sweep treats it as stranded. |
| `NR_DRIP_RECLAIM_STALE` | `false` | `true` returns stranded claims to `due`; default parks them as `stuck`. |

Shared with the rest of the app: `MONGODB_URI`, `MONGODB_DB_NAME`, `CRON_SECRET`, `WATI_*`,
`DEFAULT_COUNTRY_CODE`, `WEBSITE_URL`.

## Install

```bash
node dripcore/ensure-indexes.mjs nr_drip nr     # dev database first
```

```cron
*/15 * * * * curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" http://127.0.0.1:3000/api/cron/nr-drip
```

nginx must deny `/api/cron/` from the internet, exactly as it already does for `vsl-reminders`.
`/api/webhooks/bigin-call-outcome` is shared with the Intermediate campaign — one payload, both
decisions — and **is** public and **unauthenticated**, so anyone who learns
the URL can enrol any phone number into the drip. Nothing at the route stops them; what limits
the damage sits downstream — `NR_DRIP_ENABLED` gates all sending, `NR_DRIP_MAX_CANDIDATES`
refuses a run whose due count spikes, and `NR_DRIP_REENROLL_AFTER_HOURS` stops the same number
being enrolled over and over. If the URL leaks, restrict the path at nginx to Zoho's published
IP ranges.

## Dry running

```bash
# See who is due without sending or changing anything
curl -H "Authorization: Bearer $CRON_SECRET" "localhost:3000/api/cron/nr-drip?dryRun=1"

# Walk the whole sequence in four minutes, logging instead of sending
NR_DRIP_STEP_OFFSETS_MINUTES=0,1,2,3 WATI_DRY_RUN=true npm run dev
```

Under `WATI_DRY_RUN=true` the reply check is skipped on purpose: `getLastInboundAt` answers
"now" in dry-run mode, which would otherwise read as "everyone just replied" and cancel the
entire batch.

## Reporting

None here, by design. NR DRIP writes the `nr_drip` collection; dashboards over it are built in
**Followup_dashboard**.

## Env var names

`NR_DRIP_NR_OUTCOMES` and `NR_DRIP_STOP_OUTCOMES` are the names dripcore knows as `TRIGGER_TAGS`
and `STOP_TAGS`. They keep working unchanged — `nrdrip/campaign.ts` declares them as aliases,
because the live `.env` was typed by hand before dripcore existed. Setting
`NR_DRIP_TRIGGER_TAGS` / `NR_DRIP_STOP_TAGS` overrides the old name if you ever want to migrate.
