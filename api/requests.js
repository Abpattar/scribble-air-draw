import { requireUserId } from '../src/lib/serverAuth.js';
import {
  competitionCollection,
  friendshipCollection,
  groupCollection,
  profileCollection,
  requestsCollection,
} from '../src/lib/mongodb.js';
import { idIn } from '../api-lib/ids.js';
import { BattleError, respond as respondToBattle } from '../api-lib/battleStore.js';
import { respondToFriendship } from './friends.js';

// The one durable notification surface: friend requests, group invitations and
// battle invitations, answered from one list. Ids are prefixed with their source
// so a single endpoint can dispatch an answer to the right collection.

const BATTLE_INVITE_FIELDS = { entries: 0, votes: 0, order: 0 };

export default async function handler(request, response) {
  try {
    const userId = await requireUserId(request);
    if (!userId) return response.status(401).json({ error: 'Unauthorized: invalid session.' });
    if (request.method === 'GET') return listRequests(request, response, userId);
    if (request.method === 'POST') return answer(request, response, userId);
    return response.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    if (error instanceof BattleError) return response.status(error.status).json({ error: error.message });
    console.error('requests handler failed:', error?.message || error);
    return response.status(503).json({
      error: 'Requests are temporarily unavailable. Give it a moment and try again.',
    });
  }
}

async function listRequests(request, response, userId) {
  const now = Date.now();
  // Wave 1: identity + every pending thing addressed to this user.
  const [profile, friends, groups, battles] = await Promise.all([
    profileCollection().then((col) => col.findOne({ _id: userId })),
    friendshipCollection().then((col) =>
      col
        .find({
          status: 'pending',
          actionUserId: { $ne: userId },
          $or: [{ userA: userId }, { userB: userId }],
        })
        .toArray()
    ),
    requestsCollection().then((col) => col.find({ inviteeId: userId, status: 'pending' }).toArray()),
    // Expired invitations are not answerable, so they are not listed either.
    competitionCollection().then((col) =>
      col
        .find({ [`participants.${userId}.status`]: 'pending', invitesEndsAt: { $gt: now } })
        .project(BATTLE_INVITE_FIELDS)
        .toArray()
    ),
  ]);
  if (profile?.suspended) return response.status(401).json({ error: 'Unauthorized: invalid session.' });

  const items = [
    ...friends.map((f) => ({
      id: `friend:${f._id}`,
      kind: 'friend',
      fromUserId: f.actionUserId,
      body: 'wants to be friends with you',
      createdAt: f.createdAt || 0,
    })),
    ...groups.map((r) => ({
      id: `group:${r._id}`,
      kind: 'group',
      fromUserId: r.inviterId,
      groupId: r.groupId,
      body: `invited you to join ${r.groupEmoji || '🎨'} ${r.groupName || 'their group'}`,
      createdAt: r.createdAt || 0,
    })),
    ...battles.map((b) => ({
      id: `battle:${b._id}`,
      kind: 'battle',
      fromUserId: b.createdBy,
      battleId: String(b._id),
      body:
        (b.kind === 'duel' ? 'challenged you to a 1v1' : 'challenged your group to a battle') +
        (b.prompt ? ` — “${b.prompt}”` : ''),
      createdAt: b.createdAt || 0,
    })),
  ];

  // Wave 2: one query names everyone who sent one of these.
  const fromIds = [...new Set(items.map((i) => i.fromUserId).filter((id) => id && id !== String(userId)))];
  const fromDocs = fromIds.length ? await profileCollection().then((col) => col.find({ _id: { $in: fromIds } }).toArray()) : [];
  const from = new Map(fromDocs.map((p) => [String(p._id), p]));
  for (const item of items) {
    const who = from.get(String(item.fromUserId));
    item.title = item.fromUserId === String(userId) ? 'You' : who?.nickname || '';
    item.avatar = who?.avatar || '';
    item.accept = true;
    item.decline = true;
    delete item.fromUserId;
  }

  items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return response.status(200).json({ items, count: items.length });
}

async function answer(request, response, userId) {
  const id = String(request.body?.id || '');
  const action = request.body?.action === 'decline' ? 'decline' : 'accept';
  const accept = action === 'accept';
  const [prefix, rawId] = id.split(':');
  if (!rawId) return response.status(400).json({ error: 'Unknown request.' });
  const now = Date.now();

  if (prefix === 'friend') {
    const result = await respondToFriendship(userId, rawId, accept);
    if (!result.ok) return response.status(404).json({ error: 'That friend request is no longer there.' });
    return response.status(200).json({ ok: true, kind: 'friend', action });
  }

  if (prefix === 'group') {
    const requests = await requestsCollection();
    const invite = await requests.findOne({ _id: { $in: idIn([rawId]) }, inviteeId: userId, status: 'pending' });
    if (!invite) return response.status(404).json({ error: 'That group invitation is no longer there.' });
    const updated = await requests.findOneAndUpdate(
      { _id: invite._id, inviteeId: userId, status: 'pending' },
      { $set: { status: accept ? 'accepted' : 'declined', respondedAt: now } },
      { returnDocument: 'after' }
    );
    if (!updated) return response.status(409).json({ error: 'That invitation was already answered.' });
    // Membership changes here, once, for everybody at the same time.
    if (accept) {
      await (await groupCollection()).updateOne(
        { _id: { $in: idIn([invite.groupId]) } },
        { $addToSet: { memberIds: userId } }
      );
    }
    return response.status(200).json({ ok: true, kind: 'group', action, groupId: invite.groupId });
  }

  if (prefix === 'battle') {
    const result = await respondToBattle(userId, { id: rawId, accept, now });
    return response.status(200).json({ ok: true, kind: 'battle', action, ...result });
  }

  return response.status(400).json({ error: 'Unknown request.' });
}
