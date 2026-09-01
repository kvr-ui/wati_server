// Creates the indexes vsl_leads needs. Run against a dev database first.
//
// The unique index on `phone` is what makes the send/claim logic trustworthy — without it the
// upsert pattern can insert duplicates under a race. Against production, audit for existing
// duplicate phones and merge them BEFORE running this, or the unique build will fail.
//
//   node scripts/ensure-indexes.mjs
import { MongoClient } from 'mongodb'

const uri = process.env.MONGODB_URI
const dbName = process.env.MONGODB_DB_NAME || 'focas'
if (!uri) throw new Error('MONGODB_URI is not set')

const client = new MongoClient(uri)
await client.connect()
const leads = client.db(dbName).collection('vsl_leads')

const dupes = await leads.aggregate([
  { $group: { _id: '$phone', n: { $sum: 1 } } },
  { $match: { n: { $gt: 1 } } },
]).toArray()

if (dupes.length) {
  console.error(`Refusing to build a unique index: ${dupes.length} duplicate phone value(s) in ${dbName}.vsl_leads`)
  console.error(dupes.slice(0, 10))
  await client.close()
  process.exit(1)
}

await leads.createIndex({ phone: 1 }, { unique: true, name: 'phone_unique' })
await leads.createIndex({ leadId: 1 }, { unique: true, name: 'leadId_unique' })
await leads.createIndex({ reminderState: 1, reminderDueAt: 1 }, { name: 'reminder_queue' })

console.log(`indexes on ${dbName}.vsl_leads:`, (await leads.indexes()).map((i) => i.name).join(', '))
await client.close()
