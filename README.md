# wati_server
# focasvsl

## Lead flow: VSL first, onboarding bot an hour after the tap

```
Bigin contact created ──> vsl_final: a greeting + a button            (t = 0)
      lead taps the button ──> WATI replies with the tracked VSL link
                           ──> the tap opens their 24h window
      one hour after the tap ──> chatbots/start runs the onboarding bot
      ... and, only if they never watched ──> non-opener reminder     (t = +23h)
```

This is the reverse of the original order, where the bot came first and the VSL link was only
sent once the bot was completed — which meant the leads who never finished the bot (most of them)
never saw the video at all.

**t = 0 — `/api/webhooks/bigin-contact-created` and `/api/webhooks/zoho-flow`.** Both entry points
send `WATI_VSL_TEMPLATE_NAME` (`vsl_final`), an approved template that is a greeting plus a
button. It has to be a template — a contact who has just appeared in the CRM has never messaged
us, so there is no 24h window and free-form cannot reach them. The send goes through
`sendTrackedVslLink` (`lib/vslSend.ts`), which records `linkSentAt`; everything downstream hangs
off that timestamp, so a send that skips it drops the lead out of the sequence entirely.

`WATI_VSL_TEMPLATE_PARAMS` must name exactly the variables the template declares — `vsl_final`
declares one, `name`. A variable the template does not declare gets the message rejected outright.

**The tap is the pivot.** The link is not in the template: WATI sends it when the lead taps the
button. That same tap is the lead's first inbound message, so it is also what opens their 24h
window — which is what makes the chatbot API usable at all. Tapping a *URL* button would not do
this; WhatsApp never sees a browser click.

**t = tap + 1h — `/api/cron/onboarding-bot`.** The job runs in two phases.

*Phase one* watches for the tap. There is no WATI webhook for incoming messages, so it polls: any
inbound later than `linkSentAt` is the tap. A tapped lead is scheduled at tap + 1h; one who has
not tapped is re-checked every `ONBOARDING_BOT_TAP_CHECK_MINUTES` (30) until
`ONBOARDING_BOT_TAP_DEADLINE_HOURS` (24), then parked as `no_tap`. Each check is one WATI lookup
for one lead, so those two keys are the cost dial.

*Phase two* triggers the bot for anyone whose hour is up. The window is open by construction, so
`chatbots/start` reaches them without the lead doing anything more:

| `sessionWindowRemainingMs` | what happens |
|---|---|
| `> 0` (open) — the normal case | `chatbots/start` begins the flow |
| `<= 0` or `undefined` | the Confirm template, if one is configured — otherwise the lead is **skipped** |

`WATI_ONBOARDING_TEMPLATE_NAME` is deliberately empty, so that second row is a clean one-attempt
skip rather than a retry: nothing could have reached them. Filling that key in turns the template
fallback on with no code change.

The window is checked on our side rather than left to the API, because `chatbots/start` answers
`result: true` for *starting a flow*, not for *delivering it*: against a closed window it looks
like a success while the lead receives nothing — and still consumes a billable WATI chatbot
session. That is also why an unknown window counts as closed, unlike `dripcore/send.ts`, where a
wrong guess fails loudly and falls back on its own.

`WATI_CHATBOT_ID` is the chatbot's id, not its name — it is the `flowId` in the WATI flow builder
URL, and `node scripts/list-chatbots.mjs` prints id and name together. With neither the id nor a
template configured the job refuses to run, rather than quietly marking the whole queue skipped.

The trigger is unconditional beyond the tap — a lead who watched nothing, or who already found the
bot on their own, still gets it. What is guaranteed is **at most once per lead**, by the same
claim-before-send state machine the reminders and drips use.

Cron, alongside the existing `vsl-reminders` line — nginx must deny `/api/cron/` from the
internet, as it already does:

```
*/5 * * * * curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" http://127.0.0.1:3000/api/cron/onboarding-bot
```

Quiet hours (`ONBOARDING_BOT_QUIET_START_IST` / `_END_IST`, default 21–9 IST) defer rather than
cancel; equal start and end turns them off.

**Inspecting a run** — `?dryRun=1` reports what would be sent and changes nothing:

```
curl -H "Authorization: Bearer $CRON_SECRET" "localhost:3000/api/cron/onboarding-bot?dryRun=1"
```

State lives on the `vsl_leads` document: `onboardingState` (`waiting` → `due` → `claimed` →
`sent`, or `no_tap` when they never tapped, `window_closed` when nothing could reach them, or
`failed` / `unknown` / `stuck` when parked), `onboardingCheckAt`, `onboardingDeadlineAt`,
`onboardingTappedAt`, `onboardingDueAt`, `onboardingSentAt`,
`onboardingChannel` (`chatbot_api` or `template`), `onboardingAttempts`, `onboardingError`.
Run `node scripts/ensure-indexes.mjs` once so the queue is indexed.
