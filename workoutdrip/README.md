# Workout DRIP

Sends the workout message to leads carrying the **`WORKOUT`** Bigin tag.

One tag, one template, sent immediately — built exactly like [`../kitdrip`](../kitdrip/README.md).
The same Zoho Flow that feeds every other campaign fires on each tag change and sends **all** of
the contact's tags; this campaign asks only "is `WORKOUT` still on this contact?" and enrols, holds
or cancels accordingly.

## What it sends

`WORKOUT_DRIP_TEMPLATE_1=workout_batch_oct14` — approved on WATI, marketing category. It pitches
the Last Attempt Workout Batch: 1:10 tutoring, the question bank, the test series with video
review and the study planner, with a button to the class demo.

It declares one variable, `{{1}}` = the lead's name, so `WORKOUT_DRIP_TEMPLATE_PARAMS_1=name`.
Sending a variable a template does not declare gets the message rejected, so change this if the
template is ever swapped for one with different variables.

## Trigger matching

Whole-tag and case-insensitive: `WORKOUT` matches `Workout` or `workout`, and does not match
`Workout Plan`. Add any other spelling comma-joined to `WORKOUT_DRIP_TRIGGER_TAGS`. `CWOS` anywhere
stops the chase.

## Environment

```
WORKOUT_DRIP_ENABLED=true
WORKOUT_DRIP_TRIGGER_TAGS=WORKOUT
WORKOUT_DRIP_STOP_TAGS=CWOS
WORKOUT_DRIP_STEP_OFFSETS=0
WORKOUT_DRIP_TEMPLATE_1=workout_batch_oct14
WORKOUT_DRIP_TEMPLATE_PARAMS_1=name
WORKOUT_DRIP_QUIET_START_IST=0
WORKOUT_DRIP_QUIET_END_IST=0
```

Every other key mirrors the NR ones with this prefix; see
[`../intermediatedrip/README.md`](../intermediatedrip/README.md).

## Install

```bash
node dripcore/ensure-indexes.mjs workout_drip workout
```

No cron line — delivery is the webhook itself. `/api/cron/workout-drip` is the manual recovery
tool, and `/api/cron/drip-deliveries` covers it like every other campaign.

## Reporting

None here, by design. Writes the `workout_drip` collection; dashboards over it are built in
**Followup_dashboard**.
