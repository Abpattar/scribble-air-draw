import { MongoClient } from 'mongodb';

// Lazy + never throws at import time: a missing/unreachable MONGODB_URI must
// not crash every API route (modals fall back to seeded data instead).
const uri = process.env.MONGODB_URI;

const DB_NAME = 'neonair';
const PROFILES_COLLECTION = 'profiles';
const FRIENDSHIPS_COLLECTION = 'friendships';
const GROUPS_COLLECTION = 'groups';
const COMPETITIONS_COLLECTION = 'competitions';
const REQUESTS_COLLECTION = 'requests';
const PLANS_COLLECTION = 'plans';

let clientPromisePromise = null;

function createClient() {
  const client = new MongoClient(uri, {
    appName: 'scribble-air-draw',
    // Short enough to fail fast (then retry below or 503) rather than hang
    // near Vercel Hobby's ~10s serverless cap; leaving room for the request
    // itself after the warm-up connect.
    connectTimeoutMS: 5000,
    serverSelectionTimeoutMS: 5000,
    retryReads: true,
    retryWrites: true,
  });
  return client.connect();
}

// Atlas free/shared tiers occasionally drop a TLS handshake mid-flight.
// A cheap retry with a small backoff rides over those blips instead of
// surfacing a raw 500 to the caller.
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;

async function connectWithRetry() {
  let lastErr;
  for (let i = 0; i < RETRY_ATTEMPTS; i++) {
    try {
      return await createClient();
    } catch (error) {
      lastErr = error;
      if (i < RETRY_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * (i + 1)));
      }
    }
  }
  throw lastErr;
}

export async function getDb() {
  if (!uri) {
    throw new Error('MONGODB_URI environment variable is missing.');
  }
  if (!clientPromisePromise) {
    if (process.env.NODE_ENV !== 'production') {
      clientPromisePromise = globalThis._mongoClientPromise || connectWithRetry();
      globalThis._mongoClientPromise = clientPromisePromise;
    } else {
      clientPromisePromise = connectWithRetry();
    }
  }
  const client = await clientPromisePromise;
  return client.db(DB_NAME);
}

export const profileCollection = () => getDb().then((db) => db.collection(PROFILES_COLLECTION));
export const friendshipCollection = () => getDb().then((db) => db.collection(FRIENDSHIPS_COLLECTION));
export const groupCollection = () => getDb().then((db) => db.collection(GROUPS_COLLECTION));
export const competitionCollection = () => getDb().then((db) => db.collection(COMPETITIONS_COLLECTION));
// Pending group invitations — the durable home for "come join my group", so
// membership only changes once, when the invitee accepts.
export const requestsCollection = () => getDb().then((db) => db.collection(REQUESTS_COLLECTION));
export const planCollection = () => getDb().then((db) => db.collection(PLANS_COLLECTION));