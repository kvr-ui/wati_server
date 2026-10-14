import type { DripCampaign } from '@/dripcore/campaign'

// WORKOUT DRIP — sends the workout message to leads tagged `WORKOUT`.
//
// Independent of every other campaign: Bigin sends all of a contact's tags, so a lead carrying
// this one and another trigger tag enrols in both.
export const WORKOUT_CAMPAIGN: DripCampaign = {
  id: 'workout',
  collection: 'workout_drip',
  envPrefix: 'WORKOUT_DRIP_',
  logTag: '[WORKOUT DRIP]',
}
