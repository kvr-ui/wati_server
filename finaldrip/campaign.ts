import type { DripCampaign } from '@/dripcore/campaign'

// FINAL DRIP — sends the Final brochure to leads tagged `Final Broucher`.
//
// Independent of every other campaign: Bigin sends all of a contact's tags, so a lead carrying
// this one and another trigger tag enrols in both.
export const FINAL_CAMPAIGN: DripCampaign = {
  id: 'final',
  collection: 'final_drip',
  envPrefix: 'FINAL_DRIP_',
  logTag: '[FINAL DRIP]',
}
