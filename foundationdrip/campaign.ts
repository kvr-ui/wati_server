import type { DripCampaign } from '@/dripcore/campaign'

// FOUNDATION DRIP — sends the Foundation brochure to leads tagged `Foundation Broucher`.
//
// Independent of every other campaign: Bigin sends all of a contact's tags, so a lead carrying
// this one and another trigger tag enrols in both.
export const FOUNDATION_CAMPAIGN: DripCampaign = {
  id: 'foundation',
  collection: 'foundation_drip',
  envPrefix: 'FOUNDATION_DRIP_',
  logTag: '[FOUNDATION DRIP]',
}
