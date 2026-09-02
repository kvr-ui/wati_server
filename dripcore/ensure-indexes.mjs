// Creates the indexes one drip campaign's collection needs. Run against a dev database first.
//
// The unique index on `phone` is what makes the enrolment upsert trustworthy — without it a
// race between two webhooks can insert two drips for one human, and that lead then gets every
// message twice. Against production, audit for duplicate phones and merge them BEFORE running
// this, or the unique build will fail.
//
// Each campaign has its OWN collection precisely because of that unique index: two campaigns
// sharing one collection would collide on the phone key.
//
//   node dripcore/ensure-indexes.mjs nr_drip nr
//   node dripcore/ensure-indexes.mjs intermediate_drip intermediate
import { MongoClient } from 'mongodb'

const [collectionName, campaign] = process.argv.slice(2)
if (!collectionName || !campaign) {
  console.error('usage: node dripcore/ensure-indexes.mjs <collection> <campaign>')
  console.error('   eg: node dripcore/ensure-indexes.mjs intermediate_drip intermediate')
  process.exit(1)
}

const uri = process.env.MONGODB_URI
const dbName = process.env.MONGODB_DB_NAME || 'focas'
if (!uri) throw new Error('MONGODB_URI is not set')

const client = new MongoClient(uri)
await client.connect()
const drips = client.db(dbName).collection(collectionName)

const dupes = await drips.aggregate([
  { $group: { _id: '$phone', n: { $sum: 1 } } },
  { $match: { n: { $gt: 1 } } },
]).toArray()

if (dupes.length) {
  console.error(`Refusing to build a unique index: ${dupes.length} duplicate phone value(s) in ${dbName}.${collectionName}`)
  console.error(dupes.slice(0, 10))
  await client.close()
  process.exit(1)
}

await drips.createIndex({ phone: 1 }, { unique: true, name: 'phone_unique' })
// The runner's only hot query: everything due, oldest first.
await drips.createIndex({ state: 1, dueAt: 1 }, { name: 'drip_queue' })
// Webhook replay detection.
await drips.createIndex({ sourceCallIds: 1 }, { name: 'source_call_ids' })
// Records carry the campaign they belong to, so reporting across collections can group by it.
await drips.createIndex({ campaign: 1, state: 1 }, { name: 'campaign_state' })

// Records written before the campaign field existed all belong to this collection's campaign.
const backfilled = await drips.updateMany({ campaign: { $exists: false } }, { $set: { campaign } })
if (backfilled.modifiedCount) console.log(`backfilled campaign='${campaign}' on ${backfilled.modifiedCount} record(s)`)

console.log(`indexes on ${dbName}.${collectionName}:`, (await drips.indexes()).map((i) => i.name).join(', '))
await client.close()
