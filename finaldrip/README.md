# Final DRIP

Sends the Final brochure to leads carrying the **`Final Broucher`** Bigin tag.

One tag, one template, done. The same Zoho Flow that feeds every other campaign fires on each tag
change and sends **all** of the contact's tags; this campaign asks only "is `Final Broucher` still on
this contact?" and enrols, holds or cancels accordingly.

## What it sends

`FINAL_DRIP_TEMPLATE_1=g1_final_template` — approved on WATI, one variable (`name`, filling `{{1}}`).
**Placeholder-ish:** this is the same 1:10 tutoring body as the Intermediate template, chosen because there is no approved Final brochure — `final_template_tag` exists in WATI but is DELETED. Swap it the moment a proper one is approved.

`FINAL_DRIP_STEP_OFFSETS=0` means **one message, immediately on enrolment**. There is no
follow-up. Add `FINAL_DRIP_TEMPLATE_2` and widen the offsets if that changes.

## Independent of the other campaigns

A lead tagged `Final Broucher` *and* another trigger tag enrols in both and receives both messages —
Bigin sends every tag, and the campaigns do not know about each other. Dropping this tag cancels
only this chase. `CWOS` anywhere stops it, because stop tags override the trigger.

## Where the code is

Two files. The state machine, the send path and the webhook decision tree live in
[`dripcore/`](../dripcore), shared with every campaign. Here: `campaign.ts` (the descriptor) and
`index.ts` (the engine bound to it). Read [`../nrdrip/README.md`](../nrdrip/README.md) for how the
sequence actually behaves — it is identical.

## Environment

Every `FINAL_DRIP_*` key mirrors the NR ones with this prefix; see
[`../intermediatedrip/README.md`](../intermediatedrip/README.md) for the full table. The ones that
matter here:

```
FINAL_DRIP_ENABLED=true
FINAL_DRIP_TRIGGER_TAGS=Final Broucher
FINAL_DRIP_STOP_TAGS=CWOS
FINAL_DRIP_STEP_OFFSETS=0
FINAL_DRIP_TEMPLATE_1=g1_final_template
FINAL_DRIP_TEMPLATE_PARAMS_1=name
```

## Install

```bash
node dripcore/ensure-indexes.mjs final_drip final
```

**No cron line.** This campaign is delivered by the webhook itself — the message goes out about a
second after the tag lands, and there is no later step for a clock to fire. `FINAL_DRIP_QUIET_START_IST`
and `_QUIET_END_IST` are both `0`, which switches quiet hours OFF: with no cron there would be
nothing to release a lead held overnight, and they would simply never be messaged.

`/api/cron/final-drip` still exists and still works. It is the manual recovery tool — curl it if a
send failed and you want to push the lead through by hand.

## Reporting

None here, by design. Writes the `final_drip` collection; dashboards over it are built in
**Followup_dashboard**.
