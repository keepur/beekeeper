import { MongoClient, type Db } from "mongodb";
import type { ResolvedInstance } from "./instance-resolver.js";

/**
 * Connect to a Hive instance's MongoDB database.
 * Caller is responsible for closing the returned client.
 */
export async function connectInstance(
  instance: ResolvedInstance,
): Promise<{ client: MongoClient; db: Db }> {
  const client = new MongoClient(instance.mongoUri, {
    serverSelectionTimeoutMS: 5000,
  });
  await client.connect();
  const db = client.db(instance.dbName);
  return { client, db };
}

/**
 * Run an operation with a connected database, ensuring the client is always closed.
 */
export async function withInstanceDb<T>(
  instance: ResolvedInstance,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  const { client, db } = await connectInstance(instance);
  try {
    return await fn(db);
  } finally {
    await client.close();
  }
}
