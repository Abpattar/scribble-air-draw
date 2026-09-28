import { requireUserId } from '../src/lib/serverAuth.js';
import { friendshipCollection, profileCollection } from '../src/lib/mongodb.js';
import { safeObjectId } from '../api-lib/ids.js';

const pair = (a, b) => (a < b ? [a, b] : [b, a]);

async function resolveUsers(ids) {
  if (!ids.length) return {};
  const docs = await (await profileCollection()).find({ _id: { $in: ids } }).toArray();
  const map = {};
  for (const d of docs) {
    map[d._id] = { userId: d._id, nickname: d.nickname || '', email: d.email || '', avatar: d.avatar || '' };
  }
  return map;
}

async function profileOf(userId) {
  return (await profileCollection()).findOne({ _id: userId });
}

export default async function handler(request, response) {
  try {
    const isRequestsRoute = request.query?.route === 'requests' || (request.url || '').includes('/requests');
    if (isRequestsRoute && request.method === 'GET') return pendingRequests(request, response);

    const userId = await requireUserId(request);
    if (!userId) return response.status(401).json({ error: 'Unauthorized: invalid session.' });

    if (request.method === 'GET') return getFriends(request, response, userId);
    if (request.method === 'POST') return postFriends(request, response, userId);
    return response.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('friends handler failed:', error?.message || error);
    return response.status(503).json({
      error: 'Friends are temporarily unavailable. Give it a moment and try again.',
    });
  }
}

async function pendingRequests(request, response) {
  const userId = await requireUserId(request);
  if (!userId) {
    return response.status(401).json({ error: 'Unauthorized: invalid session.' });
  }
  try {
    const [profile, count] = await Promise.all([
      profileOf(userId),
      (await friendshipCollection()).countDocuments({
        status: 'pending',
        actionUserId: { $ne: userId },
        $or: [{ userA: userId }, { userB: userId }],
      }),
    ]);
    if (profile?.suspended) return response.status(401).json({ error: 'Unauthorized: invalid session.' });
    return response.status(200).json({ count });
  } catch (error) {
    return response.status(503).json({ error: error?.message || 'Could not load friend requests.' });
  }
}

// Answers a friendship by document id — the shape /api/requests holds, where the
// id came from a notification rather than from a user pair. Only the person the
// request was addressed to may answer it, and a decline removes the request
// exactly like the pair-based path below.
export async function respondToFriendship(userId, friendshipId, accept) {
  const col = await friendshipCollection();
  const filter = {
    _id: safeObjectId(friendshipId),
    status: 'pending',
    actionUserId: { $ne: userId },
    $or: [{ userA: userId }, { userB: userId }],
  };
  if (!accept) {
    const result = await col.deleteOne(filter);
    return { ok: (result.deletedCount || 0) === 1 };
  }
  const updated = await col.findOneAndUpdate(
    filter,
    { $set: { status: 'accepted', respondedAt: Date.now() } },
    { returnDocument: 'after' }
  );
  return { ok: Boolean(updated) };
}

async function getFriends(request, response, userId) {
  const [profile, rows] = await Promise.all([
    profileOf(userId),
    (await friendshipCollection())
      .find({ $or: [{ userA: userId }, { userB: userId }] })
      .toArray(),
  ]);
  if (profile?.suspended) return response.status(401).json({ error: 'Unauthorized: invalid session.' });

  const friends = [];
  const outgoing = [];
  const incoming = [];
  for (const r of rows) {
    const other = r.userA === userId ? r.userB : r.userA;
    if (r.status === 'accepted') friends.push(other);
    else if (r.actionUserId === userId) outgoing.push(other);
    else incoming.push(other);
  }

  const allIds = new Set([...friends, ...outgoing, ...incoming]);
  const users = await resolveUsers([...allIds]);
  const toView = (id) => ({ userId: id, ...(users[id] || { userId: id }) });

  return response.status(200).json({
    friends: friends.map(toView),
    outgoing: outgoing.map(toView),
    incoming: incoming.map(toView),
  });
}

async function postFriends(request, response, userId) {
  const col = await friendshipCollection();
  const body = request.body || {};
  const action = body.action || 'add';

  if (action === 'add') {
    const lookup = String(body.email || body.nickname || '').trim().toLowerCase();
    if (!lookup) return response.status(400).json({ error: 'Enter an email or nickname.' });
    const esc = lookup.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const target = await (await profileCollection())
      .find({
        $or: [
          { email: new RegExp(`^${esc}$`, 'i') },
          { nickname: new RegExp(`^${esc}$`, 'i') },
          { nickname: new RegExp(esc, 'i') },
        ],
      })
      .limit(10)
      .toArray();
    const matched = target.filter((t) => t._id !== userId);
    if (!matched.length) {
      return response.status(404).json({ error: 'No Scribble Air user found with that email or nickname.' });
    }

    // Prefer an exact email/nickname hit; otherwise fall back to the first
    // partial (substring) nickname match so loose searches still resolve.
    const exact = matched.find(
      (t) => (t.email || '').toLowerCase() === lookup || (t.nickname || '').toLowerCase() === lookup
    );
    const targetUser = exact || matched[0];
    const [a, b] = pair(userId, targetUser._id);
    const existing = await col.findOne({ userA: a, userB: b });
    if (existing) {
      if (existing.status === 'accepted') return response.status(200).json({ ok: true, already: true });
      if (existing.actionUserId === userId) return response.status(200).json({ ok: true, already: true });
      // They already sent us a request → this accepts it.
      await col.updateOne({ _id: existing._id }, { $set: { status: 'accepted', respondedAt: Date.now() } });
      return response.status(200).json({ ok: true, accepted: true });
    }
    await col.insertOne({ userA: a, userB: b, status: 'pending', actionUserId: userId, createdAt: Date.now() });
    return response.status(200).json({ ok: true });
  }

  const otherId = String(body.userId || '');
  const [a, b] = pair(userId, otherId);
  const existing = await col.findOne({ userA: a, userB: b });
  if (!existing) return response.status(404).json({ error: 'Friendship not found.' });

  if (action === 'accept') {
    if (existing.status === 'accepted') return response.status(200).json({ ok: true });
    if (existing.actionUserId === userId) return response.status(400).json({ error: 'That is your own outgoing request.' });
    await col.updateOne({ _id: existing._id }, { $set: { status: 'accepted', respondedAt: Date.now() } });
    return response.status(200).json({ ok: true });
  }

  if (action === 'decline' || action === 'cancel' || action === 'remove') {
    await col.deleteOne({ _id: existing._id });
    return response.status(200).json({ ok: true });
  }

  return response.status(400).json({ error: 'Unknown action.' });
}