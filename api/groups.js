import { requireUserId } from '../src/lib/serverAuth.js';
import {
  friendshipCollection,
  groupCollection,
  profileCollection,
  requestsCollection,
} from '../src/lib/mongodb.js';
import { safeObjectId } from './lib/ids.js';
import { cancelBattlesForGroup } from './lib/battleStore.js';
import { CANCEL_REASON } from './lib/battle.js';

// Pending invitations per group, for the group list + detail payloads.
async function pendingInvites(groupIds) {
  if (!groupIds.length) return new Map();
  const rows = await (await requestsCollection())
    .find({ groupId: { $in: groupIds }, status: 'pending' })
    .toArray();
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.groupId)) out.set(r.groupId, []);
    out.get(r.groupId).push({ userId: r.inviteeId, inviterId: r.inviterId, createdAt: r.createdAt || 0 });
  }
  return out;
}

async function membersOf(ids) {
  const docs = await (await profileCollection()).find({ _id: { $in: ids } }).toArray();
  const map = {};
  for (const d of docs) map[d._id] = { userId: d._id, nickname: d.nickname || '', email: d.email || '', avatar: d.avatar || '' };
  return map;
}

// Auth identity + profile/suspension check, loaded in the same wave as the
// endpoint's own first query (2 parallel Mongo round-trips total per handler).
async function profileOf(userId) {
  return (await profileCollection()).findOne({ _id: userId });
}

export default async function handler(request, response) {
  try {
    const userId = await requireUserId(request);
    if (!userId) return response.status(401).json({ error: 'Unauthorized: invalid session.' });

    const isGroupRoute = request.query?.route === 'group' || Boolean(request.query?.groupId);
    if (isGroupRoute) return groupAction(request, response, userId);

    if (request.method === 'GET') return getGroups(request, response, userId);
    if (request.method === 'POST') return createGroup(request, response, userId);
    return response.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('groups handler failed:', error?.message || error);
    return response.status(503).json({
      error: 'Groups are temporarily unavailable. Give it a moment and try again.',
    });
  }
}

async function groupAction(request, response, userId) {
  const groupId = String(request.query?.groupId || '');
  let profile;
  let group;
  try {
    [profile, group] = await Promise.all([
      profileOf(userId),
      (await groupCollection()).findOne({ _id: safeObjectId(groupId) }),
    ]);
  } catch {
    profile = null;
    group = null;
  }
  if (profile?.suspended) return response.status(401).json({ error: 'Unauthorized: invalid session.' });
  if (!group || !group.memberIds?.includes(userId)) {
    return response.status(404).json({ error: 'Group not found.' });
  }
  const isAdmin = group.adminId === userId;

  if (request.method === 'GET') {
    const [map, invited] = await Promise.all([
      membersOf(group.memberIds),
      pendingInvites([String(group._id)]),
    ]);
    return response.status(200).json({
      id: String(group._id),
      name: group.name,
      emoji: group.emoji,
      adminId: group.adminId,
      wins: group.wins || 0,
      played: group.played || 0,
      isAdmin,
      members: group.memberIds.map((id) => map[id] || { userId: id }),
      invited: invited.get(String(group._id)) || [],
    });
  }

  if (request.method !== 'POST') return response.status(405).json({ error: 'Method not allowed' });

  const col = await groupCollection();
  const action = request.body?.action || '';

  if (action === 'rename') {
    if (!isAdmin) return response.status(403).json({ error: 'Only the group creator can rename.' });
    const name = String(request.body.name || '').trim().slice(0, 40);
    if (!name) return response.status(400).json({ error: 'Group needs a name.' });
    await col.updateOne({ _id: group._id }, { $set: { name, updatedAt: Date.now() } });
    return response.status(200).json({ ok: true });
  }

  // Inviting creates a pending invitation instead of silently adding someone:
  // membership only changes when they accept, from /api/requests.
  if (action === 'invite') {
    if (!isAdmin) return response.status(403).json({ error: 'Only the group creator can invite.' });
    const memberId = String(request.body.memberId || '');
    if (!memberId) return response.status(400).json({ error: 'Pick somebody to invite.' });
    if (group.memberIds.includes(memberId)) return response.status(400).json({ error: 'Already a member.' });
    const friendship = await (await friendshipCollection()).findOne({
      status: 'accepted',
      $or: [
        { userA: userId, userB: memberId },
        { userA: memberId, userB: userId },
      ],
    });
    if (!friendship) return response.status(403).json({ error: 'You can only invite friends.' });
    await sendInvite(group, userId, [memberId]);
    return response.status(200).json({ ok: true, invited: 1 });
  }

  if (action === 'remove') {
    if (!isAdmin) return response.status(403).json({ error: 'Only the group creator can remove members.' });
    const memberId = String(request.body.memberId || '');
    if (memberId === userId) return response.status(400).json({ error: 'Use "leave" to exit the group.' });
    await col.updateOne({ _id: group._id }, { $pull: { memberIds: memberId } });
    return response.status(200).json({ ok: true });
  }

  if (action === 'leave') {
    if (group.memberIds.length <= 1) {
      await destroyGroup(group);
      return response.status(200).json({ ok: true, deleted: true });
    }
    // A live battle needs the roster it was started with, so leaving ends them.
    await cancelBattlesForGroup(groupId, { reason: CANCEL_REASON.GROUP_GONE });
    await col.updateOne({ _id: group._id }, { $pull: { memberIds: userId } });
    if (isAdmin) {
      const next = await col.findOne({ _id: group._id });
      if (next) await col.updateOne({ _id: group._id }, { $set: { adminId: next.memberIds[0] || userId } });
    }
    return response.status(200).json({ ok: true });
  }

  if (action === 'delete') {
    if (!isAdmin) return response.status(403).json({ error: 'Only the group creator can delete.' });
    await destroyGroup(group);
    return response.status(200).json({ ok: true, deleted: true });
  }

  return response.status(400).json({ error: 'Unknown action.' });
}

// Pending invitations are a document of their own so the invitee decides when
// they become a member.
async function sendInvite(group, inviterId, inviteeIds) {
  const now = Date.now();
  const requests = await requestsCollection();
  await requests.bulkWrite(
    inviteeIds.map((inviteeId) => ({
      updateOne: {
        filter: { groupId: String(group._id), inviteeId },
        update: {
          $set: {
            status: 'pending',
            inviterId,
            groupName: group.name,
            groupEmoji: group.emoji,
            createdAt: now,
            respondedAt: 0, // re-inviting re-opens a request someone had declined
          },
        },
        upsert: true,
      },
    })),
    { ordered: false }
  );
}

async function destroyGroup(group) {
  const groupId = String(group._id);
  // Live battles are cancelled, and the battle documents are kept: they are the
  // players' record of what happened, and the cancellation is the only reason
  // they ever end early.
  await cancelBattlesForGroup(groupId, { reason: CANCEL_REASON.GROUP_GONE });
  await (await requestsCollection()).deleteMany({ groupId });
  await (await groupCollection()).deleteOne({ _id: group._id });
}

async function getGroups(request, response, userId) {
  // Wave 1: profile + this user's groups + accepted friendships, in parallel.
  const [profile, rows, friendships] = await Promise.all([
    profileOf(userId),
    (await groupCollection()).find({ memberIds: userId }).sort({ createdAt: -1 }).toArray(),
    (await friendshipCollection())
      .find({ status: 'accepted', $or: [{ userA: userId }, { userB: userId }] })
      .toArray(),
  ]);
  if (profile?.suspended) return response.status(401).json({ error: 'Unauthorized: invalid session.' });

  const friendIds = friendships.map((f) => (f.userA === userId ? f.userB : f.userA));

  const memberIds = new Set();
  for (const g of rows) for (const m of g.memberIds || []) memberIds.add(m);
  for (const f of friendIds) memberIds.add(f);
  // Wave 2: one query resolves every referenced profile (group members +
  // friends) and one more collects the groups' pending invitations.
  const [map, invites] = await Promise.all([
    memberIds.size ? membersOf(Array.from(memberIds)) : {},
    pendingInvites(rows.map((g) => String(g._id))),
  ]);

  const groups = rows.map((g) => ({
    ...g,
    id: String(g._id),
    _id: undefined,
    members: (g.memberIds || []).map((id) => map[id] || { userId: id }),
    invited: invites.get(String(g._id)) || [],
  }));
  return response.status(200).json({ groups, friends: friendIds.map((id) => map[id] || { userId: id }) });
}

async function createGroup(request, response, userId) {
  const body = request.body || {};
  const name = String(body.name || '').trim().slice(0, 40);
  if (!name) return response.status(400).json({ error: 'Group needs a name.' });
  const emoji = String(body.emoji || '🎨');
  const memberIds = Array.isArray(body.memberIds)
    ? [...new Set(body.memberIds.map((m) => String(m)).filter((m) => m !== userId))].slice(0, 8)
    : [];

  const [profile, friendships] = await Promise.all([
    profileOf(userId),
    (await friendshipCollection())
      .find({ status: 'accepted', $or: [{ userA: userId }, { userB: userId }] })
      .toArray(),
  ]);
  if (profile?.suspended) return response.status(401).json({ error: 'Unauthorized: invalid session.' });

  const friendIds = new Set(friendships.map((f) => (f.userA === userId ? f.userB : f.userA)));
  const invitees = memberIds.filter((m) => friendIds.has(m));

  const col = await groupCollection();
  const result = await col.insertOne({
    name,
    emoji,
    adminId: userId,
    memberIds: [userId],
    wins: 0,
    played: 0,
    createdAt: Date.now(),
  });

  // Picked friends are invited, not added — they join when they accept.
  const group = { _id: result.insertedId, name, emoji };
  if (invitees.length) await sendInvite(group, userId, invitees);

  return response.status(200).json({ ok: true, groupId: String(result.insertedId), invited: invitees.length });
}