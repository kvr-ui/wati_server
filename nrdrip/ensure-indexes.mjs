// Creates the indexes nr_drip needs. Run against a dev database first.
//
// The unique index on `phone` is what makes the enrolment upsert trustworthy — without it a
// race between two call webhooks can insert two drips for one human, and that lead then gets
// every message twice. Against production, audit for duplicate phones and merge them BEFORE
// running this, or the unique build will fail.
//
//   node nrdrip/ensure-indexes.mjs
import { MongoClient } from 'mongodb'

const uri = process.env.MONGODB_URI
const dbName = process.env.MONGODB_DB_NAME || 'focas'
if (!uri) throw new Error('MONGODB_URI is not set')

const client = new MongoClient(uri)
await client.connect()
const drips = client.db(dbName).collection('nr_drip')

const dupes = await drips.aggregate([
  { $group: { _id: '$phone', n: { $sum: 1 } } },
  { $match: { n: { $gt: 1 } } },
]).toArray()

if (dupes.length) {
  console.error(`Refusing to build a unique index: ${dupes.length} duplicate phone value(s) in ${dbName}.nr_drip`)
  console.error(dupes.slice(0, 10))
  await client.close()
  process.exit(1)
}

await drips.createIndex({ phone: 1 }, { unique: true, name: 'phone_unique' })
// The runner's only hot query: everything due, oldest first.
await drips.createIndex({ state: 1, dueAt: 1 }, { name: 'drip_queue' })
// Webhook replay detection.
await drips.createIndex({ sourceCallIds: 1 }, { name: 'source_call_ids' })

console.log(`indexes on ${dbName}.nr_drip:`, (await drips.indexes()).map((i) => i.name).join(', '))
await client.close()
