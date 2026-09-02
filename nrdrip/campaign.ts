import type { DripCampaign } from '@/dripcore/campaign'

// NR DRIP — chases leads the sales team could not reach. See README.md.
//
// The engine lives in dripcore/; this file is the whole of what makes NR different from any
// other tag campaign.
export const NR_CAMPAIGN: DripCampaign = {
  id: 'nr',
  collection: 'nr_drip',
  envPrefix: 'NR_DRIP_',
  logTag: '[NR DRIP]',

  // NR DRIP was configured by hand on a live server before dripcore existed, and `.env` is
  // gitignored — so the keys already typed there must keep working. The generic name still wins
  // when it is set, which is how NR can migrate off these later without a flag day.
  aliases: {
    TRIGGER_TAGS: ['NR_DRIP_NR_OUTCOMES'],
    STOP_TAGS: ['NR_DRIP_STOP_OUTCOMES'],
    // Renamed once already: it cancels on any tag change, not only on "connected".
    CANCEL_ON_TAG_CHANGE: ['NR_DRIP_CANCEL_ON_CONNECTED'],
  },
}
