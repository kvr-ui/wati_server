import { MongoClient } from 'mongodb'

const uri = process.env.MONGODB_URI
let client: MongoClient | undefined
let promise: Promise<MongoClient> | undefined

export async function getDb() {
  if (!uri) throw new Error('MONGODB_URI is not configured')
  client ??= new MongoClient(uri)
  promise ??= client.connect()
  return (await promise).db(process.env.MONGODB_DB_NAME || 'focas')
}
