import type { DripCampaign } from '@/dripcore/campaign'

// KIT DRIP — sends the kit message to leads tagged `Kit`.
//
// Independent of every other campaign: Bigin sends all of a contact's tags, so a lead carrying
// this one and another trigger tag enrols in both.
export const KIT_CAMPAIGN: DripCampaign = {
  id: 'kit',
  collection: 'kit_drip',
  envPrefix: 'KIT_DRIP_',
  logTag: '[KIT DRIP]',
}
