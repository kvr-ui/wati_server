// Every drip campaign the app runs, in one list.
//
// The Bigin webhook walks this: one payload, one decision per campaign, each independent. Adding a
// campaign means adding its folder and one line here — nothing in dripcore/ or the route changes.
//
// Order matters only for the webhook response, where the first entry's result is also returned at
// the top level for the monitoring that predates the later campaigns.

import type { DripConfig } from '@/dripcore/config'
import { nrConfig } from '@/nrdrip'
import { intermediateConfig } from '@/intermediatedrip'
import { foundationConfig } from '@/foundationdrip'
import { finalConfig } from '@/finaldrip'
import { kitConfig } from '@/kitdrip'

export const ALL_DRIPS: DripConfig[] = [nrConfig, intermediateConfig, foundationConfig, finalConfig, kitConfig]
