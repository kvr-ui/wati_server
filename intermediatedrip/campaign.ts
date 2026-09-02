import type { DripCampaign } from '@/dripcore/campaign'

// INTERMEDIATE DRIP — nurtures leads carrying the `Intermediate` Bigin tag. See README.md.
//
// Independent of NR DRIP: Bigin sends every tag the contact carries, so a lead tagged
// `NR,Intermediate` is a trigger for both campaigns and receives both sequences.
//
// No aliases — this campaign has only ever had the generic key names.
export const INTERMEDIATE_CAMPAIGN: DripCampaign = {
  id: 'intermediate',
  collection: 'intermediate_drip',
  envPrefix: 'INTERMEDIATE_DRIP_',
  logTag: '[INTERMEDIATE DRIP]',
}
