# Kit DRIP

Sends the kit message to leads carrying the **`Kit`** Bigin tag.

One tag, one template, sent immediately. The same Zoho Flow that feeds every other campaign fires
on each tag change and sends **all** of the contact's tags; this campaign asks only "is `Kit` still
on this contact?" and enrols, holds or cancels accordingly.

## What it sends

`KIT_DRIP_TEMPLATE_1=education_kit_details` — approved on WATI, marketing category. It walks
through what the kit contains: the Infinite Question Bank, the FOCAS Planner, the FOCAS Manual and
the video evaluations.

**It declares no variables**, which is why `KIT_DRIP_TEMPLATE_PARAMS_1=none`. That is not a
formality — passing a variable a template does not declare gets the message rejected by WATI, and
an empty env value is indistinguishable from an unset one, so `none` is how a step says "no
variables" out loud. Every other campaign sends `name`; this one must not.

`KIT_DRIP_STEP_OFFSETS=0` means **one message, immediately on enrolment**. There is no follow-up.
Add `KIT_DRIP_TEMPLATE_2` and widen the offsets if that changes.

## Immediate delivery

The message goes out about a second after the tag lands, not on a cron tick. The Bigin webhook
enrols the lead, answers Zoho 200, then runs the ordinary runner scoped to that one phone in an
`after()` block — so a slow WATI can never make Zoho time out and re-fire the hook. Three attempts,
about five and fifteen seconds apart, cover a transient WATI failure. That path is already generic:
adding this campaign to [`lib/drips.ts`](../lib/drips.ts) is what turns it on, and nothing in
[`dripcore/`](../dripcore) or the webhook route changed.

## Independent of the other campaigns

A lead tagged `Kit` *and* another trigger tag enrols in both and receives both messages — Bigin
sends every tag, and the campaigns do not know about each other. Dropping this tag cancels only
this chase. `CWOS` anywhere stops it, because stop tags override the trigger.

## Trigger matching is per-tag, not a substring

`isTriggerTag` splits Bigin's comma-joined string and compares each tag whole, case-insensitively.
Bigin sends this one as **`Kit`**, so that is the whole trigger list. Note that the match is on the
whole tag: `Kit` matches `Kit` or `kit` and does **not** match `Kit Broucher`, the way the Foundation
and Final tags are worded. If a second spelling ever shows up, add it comma-joined —
`KIT_DRIP_TRIGGER_TAGS=Kit,Kit Broucher` — rather than expecting a partial match to catch it.

## Where the code is

Two files. The state machine, the send path and the webhook decision tree live in
[`dripcore/`](../dripcore), shared with every campaign. Here: `campaign.ts` (the descriptor) and
`index.ts` (the engine bound to it). Read [`../nrdrip/README.md`](../nrdrip/README.md) for how the
sequence actually behaves — it is identical.

## Environment

Every `KIT_DRIP_*` key mirrors the NR ones with this prefix; see
[`../intermediatedrip/README.md`](../intermediatedrip/README.md) for the full table. The ones that
matter here:

```
KIT_DRIP_ENABLED=true
KIT_DRIP_TRIGGER_TAGS=Kit
KIT_DRIP_STOP_TAGS=CWOS
KIT_DRIP_STEP_OFFSETS=0
KIT_DRIP_TEMPLATE_1=education_kit_details
KIT_DRIP_TEMPLATE_PARAMS_1=none
```

## Install

```bash
node dripcore/ensure-indexes.mjs kit_drip kit
```

**No cron line.** This campaign is delivered by the webhook itself, and there is no later step for a
clock to fire. `KIT_DRIP_QUIET_START_IST` and `_QUIET_END_IST` are both `0`, which switches quiet
hours OFF: with no cron there would be nothing to release a lead held overnight, and they would
simply never be messaged.

`/api/cron/kit-drip` still exists and still works. It is the manual recovery tool — curl it if a
send failed and you want to push the lead through by hand.

## Reporting

None here, by design. Writes the `kit_drip` collection; dashboards over it are built in
**Followup_dashboard**.
