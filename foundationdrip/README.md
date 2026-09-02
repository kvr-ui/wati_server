# Foundation DRIP

Sends the Foundation brochure to leads carrying the **`Foundation Broucher`** Bigin tag.

One tag, one template, done. The same Zoho Flow that feeds every other campaign fires on each tag
change and sends **all** of the contact's tags; this campaign asks only "is `Foundation Broucher` still on
this contact?" and enrols, holds or cancels accordingly.

## What it sends

`FOUNDATION_DRIP_TEMPLATE_1=foundation_template_tag` — approved on WATI, one variable (`name`, filling `{{1}}`).
Foundation-specific brochure copy, opening on Business Law being where most Foundation students lose marks.

`FOUNDATION_DRIP_STEP_OFFSETS=0` means **one message, immediately on enrolment**. There is no
follow-up. Add `FOUNDATION_DRIP_TEMPLATE_2` and widen the offsets if that changes.

## Independent of the other campaigns

A lead tagged `Foundation Broucher` *and* another trigger tag enrols in both and receives both messages —
Bigin sends every tag, and the campaigns do not know about each other. Dropping this tag cancels
only this chase. `CWOS` anywhere stops it, because stop tags override the trigger.

## Where the code is

Two files. The state machine, the send path and the webhook decision tree live in
[`dripcore/`](../dripcore), shared with every campaign. Here: `campaign.ts` (the descriptor) and
`index.ts` (the engine bound to it). Read [`../nrdrip/README.md`](../nrdrip/README.md) for how the
sequence actually behaves — it is identical.

## Environment

Every `FOUNDATION_DRIP_*` key mirrors the NR ones with this prefix; see
[`../intermediatedrip/README.md`](../intermediatedrip/README.md) for the full table. The ones that
matter here:

```
FOUNDATION_DRIP_ENABLED=true
FOUNDATION_DRIP_TRIGGER_TAGS=Foundation Broucher
FOUNDATION_DRIP_STOP_TAGS=CWOS
FOUNDATION_DRIP_STEP_OFFSETS=0
FOUNDATION_DRIP_TEMPLATE_1=foundation_template_tag
FOUNDATION_DRIP_TEMPLATE_PARAMS_1=name
```

## Install

```bash
node dripcore/ensure-indexes.mjs foundation_drip foundation
```

**No cron line.** This campaign is delivered by the webhook itself — the message goes out about a
second after the tag lands, and there is no later step for a clock to fire. `FOUNDATION_DRIP_QUIET_START_IST`
and `_QUIET_END_IST` are both `0`, which switches quiet hours OFF: with no cron there would be
nothing to release a lead held overnight, and they would simply never be messaged.

`/api/cron/foundation-drip` still exists and still works. It is the manual recovery tool — curl it if a
send failed and you want to push the lead through by hand.

## Reporting

None here, by design. Writes the `foundation_drip` collection; dashboards over it are built in
**Followup_dashboard**.
