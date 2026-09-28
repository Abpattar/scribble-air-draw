import { requireUserId } from '../src/lib/serverAuth.js';
import { profileCollection } from '../src/lib/mongodb.js';
import { ensurePlans, entitlementFor } from '../api-lib/catalog.js';

// Fields that are strictly server-controlled and must never be writable by
// the client, mirroring how `subscribed` already worked.
const SERVER_ONLY = new Set([
  '_id',
  'subscribed',
  'subscribedUntil',
  'subscriptionId',
  'plan',
  'payments',
  'suspended',
  'role',
  'createdAt',
  'updatedAt',
]);

const SUPERADMIN_EMAIL = (process.env.SUPERADMIN_EMAIL || '').toLowerCase().trim();

function emailMatch(email) {
  return SUPERADMIN_EMAIL && SUPERADMIN_EMAIL === String(email || '').toLowerCase().trim();
}

export default async function handler(request, response) {
  if (request.method === 'GET') {
    return getProfile(request, response);
  }
  if (request.method === 'POST' || request.method === 'PUT') {
    return saveProfile(request, response);
  }
  return response.status(405).json({ error: 'Method not allowed' });
}

async function getProfile(request, response) {
  const userId = await requireUserId(request);
  if (!userId) {
    return response.status(401).json({ error: 'Unauthorized: invalid session.' });
  }

  try {
    const col = await profileCollection();
    let doc = await col.findOne({ _id: userId });
    if (!doc) {
      // First time this Clerk user loads the app: provision a default profile
      // document so they are immediately searchable in Friends and can use
      // groups/battles. The nickname screen and drawing saves enrich it.
      doc = {
        _id: userId,
        nickname: '',
        bio: '',
        email: '',
        avatar: '',
        favorites: {},
        drawings: {},
        history: {},
        subscribed: false,
        subscribedUntil: null,
        plan: null,
        payments: [],
        role: 'user',
        suspended: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await col.insertOne(doc);
    }
    // Keep silently back-compatible: any matching SUPERADMIN_EMAIL gets the
    // superadmin role on sight (bootstrap for the first admin).
    if (emailMatch(doc.email) && doc.role !== 'superadmin') {
      await col.updateOne({ _id: userId }, { $set: { role: 'superadmin' } });
      doc.role = 'superadmin';
    }
    const { _id, ...profile } = doc;
    // Attach the user's current entitlement (which plan gates what) so the
    // client can render locks + the plans UI without extra round-trips.
    await ensurePlans();
    const entitlement = await entitlementFor(doc);
    profile.features = entitlement.features;
    profile.galleryLimit = entitlement.galleryLimit;
    return response.status(200).json({ profile });
  } catch (error) {
    console.error('Failed to load profile:', error);
    return response.status(500).json({ error: 'Failed to load profile.' });
  }
}

async function saveProfile(request, response) {
  const userId = await requireUserId(request);
  if (!userId) {
    return response.status(401).json({ error: 'Unauthorized: invalid session.' });
  }

  const data = request.body && typeof request.body === 'object' ? { ...request.body } : {};
  // Strip every server-controlled field so the client can never self-flag
  // as subscribed, admin, superadmin, etc.
  SERVER_ONLY.forEach((k) => delete data[k]);

  try {
    const role = emailMatch(data.email) ? 'superadmin' : 'user';
    await (await profileCollection()).updateOne(
      { _id: userId },
      {
        $set: { ...data, role, updatedAt: Date.now() },
        $setOnInsert: { subscribed: false, suspended: false, payments: [], createdAt: Date.now() },
      },
      { upsert: true }
    );
    return response.status(200).json({ ok: true });
  } catch (error) {
    console.error('Failed to save profile:', error);
    return response.status(500).json({ error: 'Failed to save profile.' });
  }
}