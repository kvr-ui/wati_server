# INTERMEDIATE DRIP

A WhatsApp drip for leads carrying the **`Intermediate`** Bigin tag.

The same Zoho Flow that feeds NR DRIP fires on every tag change and sends **every** tag the
contact currently carries. This campaign asks one question of each payload — "is `Intermediate`
still on this contact?" — and enrols, continues or cancels accordingly.

## Independent of NR DRIP

The two campaigns do not know about each other. A lead tagged `NR,Intermediate` is a trigger for
both, enrols in both, and **receives both sequences**. Removing one tag ends only that campaign's
chase; the other keeps running.

| Tags on the contact | NR DRIP | INTERMEDIATE DRIP |
|---|---|---|
| `NR` | chases | — |
| `Intermediate` | cancels (tag changed) | chases |
| `NR,Intermediate` | chases | chases — **two sequences to one person** |
| `NR,CWOS` | stops | — |
| `Intermediate,CWOS` | — | stops |
| *(tag removed entirely)* | cancels | cancels |

That doubled volume is the deliberate consequence of independence. A contact carrying two trigger
tags is messaged once per campaign, and because the brochure campaigns now send from the webhook,
those two messages land seconds apart rather than being spread by staggered cron lines. If that
reads as spam, the fix is `INTERMEDIATE_DRIP_ENABLED=false` — or deciding one campaign should
suppress the other, which is a rule in `dripcore/webhook.ts`.

## Where the code is

Almost nowhere. The state machine, the send path and the webhook decision tree live in
[`dripcore/`](../dripcore) and are shared with NR DRIP — a bug fixed there is fixed for both.
This folder is two files: `campaign.ts` (the descriptor: id, collection, env prefix, log tag) and
`index.ts` (dripcore bound to it).

Read [`../nrdrip/README.md`](../nrdrip/README.md) for how the sequence actually behaves — the flow
diagram, the state machine and the send rules are identical.

## Before you switch it on

**Every step needs a Meta-approved WhatsApp template.** WATI free-form messages only work within
24h of the lead's *last inbound message*, and the cancel rule makes that near-circular: an open
window means a recent inbound, which means the lead replied, which cancels the drip. The session
path is opportunistic; the templates are what actually deliver.

With `INTERMEDIATE_DRIP_ENABLED=true` and no template for a step, that step is **skipped** and the
lead moves on — it does not park them. So a step whose template does not exist yet is safe to add,
but a campaign with no templates at all enrols leads and sends them nothing.

### Step 1

`INTERMEDIATE_DRIP_TEMPLATE_1=intermediate_wati_updated` — APPROVED on WATI, English (US), and it
declares exactly **one** variable, `name`, filling `{{1}}` in "Hi {{1}}". That is why
`INTERMEDIATE_DRIP_TEMPLATE_PARAMS_1=name`: passing anything the template does not declare risks
WATI rejecting the send outright.

The cadence is `INTERMEDIATE_DRIP_STEP_OFFSETS=0` — **one message, sent immediately on enrolment**.
Add `INTERMEDIATE_DRIP_TEMPLATE_2` and widen the offsets (`0,24`) when a Day 1 message exists.

`INTERMEDIATE_DRIP_ENABLED=true`. On the server that means real WhatsApp messages the moment a
lead is tagged `Intermediate` and the cron ticks. Set it back to `false` to stop the campaign
without touching anything else — enrolments continue, sends do not.

## Environment

Identical to NR DRIP's keys with an `INTERMEDIATE_DRIP_` prefix instead of `NR_DRIP_`, and the
generic tag names:

| Variable | Default | Purpose |
|---|---|---|
| `INTERMEDIATE_DRIP_ENABLED` | `false` | Master switch. Nothing sends unless `true`. |
| `INTERMEDIATE_DRIP_TRIGGER_TAGS` | — | Tags that enrol, comma-separated, case-insensitive. Empty = nothing enrols **and nothing cancels**. |
| `INTERMEDIATE_DRIP_STOP_TAGS` | — | Tags that end the chase even when the trigger is also present. Outcome tags only. |
| `INTERMEDIATE_DRIP_CANCEL_ON_TAG_CHANGE` | `true` | The trigger tag going away cancels an active drip. |
| `INTERMEDIATE_DRIP_STEP_OFFSETS` | `0,24,72` | Hours from enrolment per step. Length sets the step count. |
| `INTERMEDIATE_DRIP_STEP_OFFSETS_MINUTES` | — | Overrides the above. Testing only. |
| `INTERMEDIATE_DRIP_MESSAGE_1..n` | — | Session copy per step. Supports `{{name}}`, `{{url}}`, literal `\n`. |
| `INTERMEDIATE_DRIP_TEMPLATE_1..n` | — | Approved template name per step. Required in practice. |
| `INTERMEDIATE_DRIP_TEMPLATE_PARAMS_1..n` | `name` | Variables to send with that step's template. `none` for a template that declares none. |
| `INTERMEDIATE_DRIP_URL` | the lead's VSL link | Where the copy points. |
| `INTERMEDIATE_DRIP_REENROLL_AFTER_HOURS` | `168` | A finished drip that sent something cannot restart inside this window. |
| `INTERMEDIATE_DRIP_QUIET_START_IST` / `_QUIET_END_IST` | `21` / `9` | Quiet hours (Asia/Kolkata). |
| `INTERMEDIATE_DRIP_BATCH` | `25` | Max leads per run. |
| `INTERMEDIATE_DRIP_SEND_GAP_MS` | `400` | Pause between sends. |
| `INTERMEDIATE_DRIP_RETRY_BACKOFF_MINUTES` | `15` | Failed-step wait, multiplied by the attempt number. |
| `INTERMEDIATE_DRIP_MAX_CANDIDATES` | `200` | Circuit breaker — above this the run refuses to send at all. |
| `INTERMEDIATE_DRIP_STALE_MINUTES` | `15` | Claim age before the sweep treats it as stranded. |
| `INTERMEDIATE_DRIP_RECLAIM_STALE` | `false` | `true` returns stranded claims to `due`; default parks them as `stuck`. |

## Install

```bash
node dripcore/ensure-indexes.mjs intermediate_drip intermediate    # dev database first
```

**No cron line.** This campaign is delivered by the webhook itself — the message goes out about a
second after the tag lands, and there is no later step for a clock to fire.
`INTERMEDIATE_DRIP_QUIET_START_IST` and `_QUIET_END_IST` are both `0`, which switches quiet hours
OFF: with no cron there would be nothing to release a lead held overnight, and they would simply
never be messaged.

`/api/cron/intermediate-drip` still exists and still works. It is the manual recovery tool — curl
it if a send failed and you want to push the lead through by hand.

nginx must deny `/api/cron/` from the internet. The webhook this campaign shares with NR DRIP,
`/api/webhooks/bigin-call-outcome`, **is** public and unauthenticated — see
[`../nrdrip/KNOWN-ISSUES.md`](../nrdrip/KNOWN-ISSUES.md) §1.3, which now applies to two campaigns
rather than one.

## Dry running

```bash
# See who is due without sending or changing anything
curl -H "Authorization: Bearer $CRON_SECRET" "localhost:3000/api/cron/intermediate-drip?dryRun=1"

# Walk the whole sequence in three minutes, logging instead of sending
INTERMEDIATE_DRIP_ENABLED=true INTERMEDIATE_DRIP_STEP_OFFSETS_MINUTES=0,1,2 WATI_DRY_RUN=true npm run dev
```

## Reporting

None here, by design. This campaign writes the `intermediate_drip` collection; dashboards over it
are built in **Followup_dashboard**.
