import {
  competitionCollection,
  friendshipCollection,
  groupCollection,
  profileCollection,
  requestsCollection,
} from '../src/lib/mongodb.js';
import { idFilter, idIn } from './ids.js';
import {
  BATTLE_PROMPTS,
  CANCEL_REASON,
  INVITE_WINDOW_MS,
  MAX_PROMPT_CHARS,
  MAX_STROKES_PER_ENTRY,
  MAX_TITLE_CHARS,
  acceptedCounts,
  allAcceptedReady,
  canSeeStrokes,
  checkCancel,
  checkReady,
  checkRespond,
  checkSubmit,
  checkSync,
  checkVote,
  isFinalPhase,
  isLegacyBattle,
  participantOf,
  pendingExpired,
  phaseOf,
  phasePatch,
  playerTurnFor,
  readyEndsAtOf,
  settleFilter,
  sideFor,
  tallyVotes,
  turnWindowFor,
  validateSyncPayload,
} from './battle.js';

// Persistence for battles. Every decision (phase, whose turn, who may write,
// who won) comes from ./battle.js, which is pure; this module only reads and
// writes documents and applies those decisions as guarded updates.
//
// Every export takes (userId, input, deps). `deps` overrides the collections
// ({ competitions, groups, profiles, requests }) so the whole store can be
// driven against a throwaway database. `input.doc` lets the HTTP layer do its
// identity read in the same Mongo wave as the battle read.

export class BattleError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const REAL = {
  competitions: competitionCollection,
  groups: groupCollection,
  profiles: profileCollection,
  friendships: friendshipCollection,
  requests: requestsCollection,
};

const collection = (deps, name) => deps?.[name] || REAL[name]();

const EMPTY_ENTRY = { strokes: [], updatedAt: 0, submittedAt: 0, rev: 0 };

// Both entry slots, whichever way the document is keyed (side letter now, group
// id for battles written before the phase machine).
function entriesOf(doc) {
  const entries = doc.entries || {};
  if (doc.participants) {
    return { A: entries.A || EMPTY_ENTRY, B: entries.B || EMPTY_ENTRY };
  }
  return {
    A: (doc.groupA && entries[doc.groupA]) || EMPTY_ENTRY,
    B: (doc.groupB && entries[doc.groupB]) || EMPTY_ENTRY,
  };
}

export async function findBattle(id, deps = {}) {
  const competitions = await collection(deps, 'competitions');
  return competitions.findOne(idFilter(id));
}

// Persists the phase boundary the document has already reached — and only that.
// Nothing else in the lifecycle is written, so a battle can never get stuck.
export async function advanceBattle(doc, deps = {}, now = Date.now()) {
  const patch = phasePatch(doc, now);
  if (!patch) return doc;
  const competitions = await collection(deps, 'competitions');
  const updated = await competitions.findOneAndUpdate(
    { _id: doc._id, ...patch.guard },
    { $set: patch.set, $inc: { rev: 1 } },
    { returnDocument: 'after' }
  );
  return updated || doc;
}

export async function loadBattle(id, deps = {}, now = Date.now()) {
  return advanceBattle(await findBattle(id, deps), deps, now);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

// Display data for a set of battles: every referenced group and every
// participant profile, in one query each.
async function readRefs(docs, deps) {
  const groupIds = new Set();
  const userIds = new Set();
  for (const doc of docs) {
    for (const id of [doc.groupA, doc.groupB]) if (id) groupIds.add(String(id));
    for (const userId of Object.keys(doc.participants || {})) userIds.add(userId);
  }
  const groups = await collection(deps, 'groups');
  const profiles = await collection(deps, 'profiles');
  const [groupDocs, profileDocs] = await Promise.all([
    groupIds.size ? groups.find({ _id: { $in: idIn([...groupIds]) } }).toArray() : [],
    userIds.size ? profiles.find({ _id: { $in: [...userIds] } }).toArray() : [],
  ]);
  return {
    groups: new Map(groupDocs.map((g) => [String(g._id), g])),
    profiles: new Map(profileDocs.map((p) => [String(p._id), p])),
  };
}

function otherParticipant(doc, side) {
  const wanted = side === 'A' ? 'B' : 'A';
  for (const [userId, p] of Object.entries(doc.participants || {})) {
    if (p?.side === wanted) return userId;
  }
  return null;
}

// One side of the battle, named and emoji'd from the live group/profile with
// the document's own snapshot as the fallback.
function sideInfo(doc, refs, side) {
  const groupId = side === 'A' ? doc.groupA : doc.groupB;
  const snapshot = side === 'A' ? doc.aTitle : doc.bTitle;
  if (groupId) {
    const group = refs.groups.get(String(groupId));
    return {
      id: String(groupId),
      name: group?.name || snapshot || 'Group',
      emoji: group?.emoji || '🎨',
      kind: 'group',
    };
  }
  const opponent = otherParticipant(doc, side);
  const profile = opponent ? refs.profiles.get(String(opponent)) : null;
  return {
    id: null,
    userId: opponent || null,
    name: profile?.nickname || snapshot || (side === 'A' ? 'Player 1' : 'Player 2'),
    emoji: profile?.avatar || '🎨',
    kind: 'player',
  };
}

export function mySideOf(doc, userId, refs) {
  const p = participantOf(doc, userId);
  if (p) return p.status === 'declined' ? null : p.side;
  // Battles from before the phase machine had no roster: fall back to group
  // membership so they still render for the people who were in those groups.
  for (const side of ['A', 'B']) {
    const groupId = side === 'A' ? doc.groupA : doc.groupB;
    if (groupId && refs.groups.get(String(groupId))?.memberIds?.includes(userId)) return side;
  }
  return null;
}

// The view every client renders from. Never contains stroke data unless it was
// explicitly asked for — that is the whole point of the traffic budget — and
// never contains it while the drawing window is open unless the caller is in
// the battle: asking for pixels is a payload decision, not a permission.
export function battleView(doc, refs, userId, now, withStrokes) {
  const phase = phaseOf(doc, now);
  const entries = entriesOf(doc);
  const side = mySideOf(doc, userId, refs);
  const me = participantOf(doc, userId);
  const tallied = tallyVotes(doc);
  const counts = acceptedCounts(doc);
  // Visibility is decided per side, not once for the whole battle: during the
  // drawing window a player may read their own team's canvas and never the
  // other side's, so the rival's strokes stay redacted until voting opens.
  const strokesVisibleFor = (s) => withStrokes && canSeeStrokes(phase, side, s);

  return {
    id: String(doc._id),
    kind: doc.kind || (isLegacyBattle(doc) ? 'group' : 'duel'),
    prompt: doc.prompt || '',
    createdAt: doc.createdAt || 0,
    createdBy: doc.createdBy || null,
    rev: doc.rev || 0,
    status: phase,
    phase,
    groupA: sideInfo(doc, refs, 'A'),
    groupB: sideInfo(doc, refs, 'B'),
    invitesEndsAt: doc.invitesEndsAt || 0,
    readyEndsAt: readyEndsAtOf(doc, now) || 0,
    countdownEndsAt: doc.countdownEndsAt || 0,
    drawStartAt: doc.drawStartAt || 0,
    drawEndsAt: doc.drawEndsAt || 0,
    voteEndsAt: doc.voteEndsAt || 0,
    drawEndTime: doc.drawEndsAt || doc.drawEndTime || 0,
    voteEndTime: doc.voteEndsAt || doc.voteEndTime || 0,
    turnMs: doc.turnMs || 0,
    turn: { A: turnWindowFor(doc, 'A', now), B: turnWindowFor(doc, 'B', now) },
    mySide: side,
    myStatus: me?.status || null,
    myReady: Boolean(me?.readyAt),
    myGroup: side ? (side === 'A' ? doc.groupA || null : doc.groupB || null) : null,
    myTurn: playerTurnFor(doc, userId),
    participants: Object.entries(doc.participants || {}).map(([uid, p]) => ({
      userId: uid,
      side: p.side,
      status: pendingExpired(doc, now) && p.status === 'pending' ? 'declined' : p.status,
      ready: Boolean(p.readyAt),
      turnEnded: Boolean(p.turnEndedAt),
      submitted: Boolean(p.submittedAt),
      nickname: refs.profiles.get(String(uid))?.nickname || '',
      avatar: refs.profiles.get(String(uid))?.avatar || '',
      you: uid === String(userId),
    })),
    accepted: counts,
    // Per side: artwork metadata always, pixel data only on request and only
    // once the battle may actually be watched.
    entries: ['A', 'B'].map((s) => {
      const entry = entries[s];
      return {
        side: s,
        groupId: (s === 'A' ? doc.groupA : doc.groupB) || null,
        strokeCount: entry.strokes?.length || 0,
        updatedAt: entry.updatedAt || 0,
        submittedAt: entry.submittedAt || 0,
        rev: entry.rev || 0,
        strokes: strokesVisibleFor(s) ? entry.strokes || [] : null,
      };
    }),
    myVote: doc.votes?.[userId] || null,
    hasVoted: Boolean(doc.votes?.[userId]),
    votes: phase === 'voting' || phase === 'closed' ? { A: tallied.A, B: tallied.B } : null,
    winner: phase === 'closed' ? tallied.winner : null,
    closedAt: doc.closedAt || 0,
    cancelledAt: doc.cancelledAt || 0,
    cancelReason: doc.cancelReason || '',
  };
}

// Lazily tallies a finished battle — one guarded update for the battle, one
// bulkWrite for the group leaderboards. Same behaviour as before, two round
// trips instead of three sequential ones.
export async function settleBattle(doc, deps = {}, now = Date.now()) {
  if (phaseOf(doc, now) !== 'closed' || doc.closedAt) return doc;
  const tallied = tallyVotes(doc);
  const competitions = await collection(deps, 'competitions');
  const result = await competitions.updateOne({ _id: doc._id, ...settleFilter(now) }, {
    $set: { winner: tallied.winner, closedAt: now },
    $inc: { rev: 1 },
  });
  if (result.matchedCount !== 1) return doc; // someone else settled it first

  const ops = [];
  for (const [side, groupId] of [['A', doc.groupA], ['B', doc.groupB]]) {
    if (!groupId) continue;
    const inc = { played: 1 };
    if (tallied.winner === side) inc.wins = 1;
    ops.push({ updateOne: { filter: { _id: { $in: idIn([groupId]) } }, update: { $inc: inc } } });
  }
  if (ops.length) {
    const groups = await collection(deps, 'groups');
    await groups.bulkWrite(ops);
  }
  return { ...doc, winner: tallied.winner, closedAt: now };
}

export async function getBattle(userId, input = {}, deps = {}) {
  const now = input.now || Date.now();
  const doc = input.doc || (await findBattle(input.id, deps));
  if (!doc) throw new BattleError(404, 'Battle not found.');

  // One wave: advance the phase, settle a finished battle, and read the names.
  const [advanced, settled, refs] = await Promise.all([
    advanceBattle(doc, deps, now),
    settleBattle(doc, deps, now),
    readRefs([doc], deps),
  ]);
  return battleView(settled === doc ? advanced : settled, refs, userId, now, Boolean(input.strokes));
}

export async function listBattles(userId, input = {}, deps = {}) {
  const now = input.now || Date.now();
  const competitions = await collection(deps, 'competitions');
  const groups = await collection(deps, 'groups');

  // The feed is the caller's own battles: a modern battle lists every member of
  // both groups as a participant, and the group ids cover the ones written before
  // the phase machine had a roster. The ids come first because the battle query
  // is scoped by them.
  const mine = await groups.find({ memberIds: userId }).project({ _id: 1 }).toArray();
  const groupForms = idIn(mine.map((g) => String(g._id)));
  const visible = {
    $or: [
      { [`participants.${userId}`]: { $exists: true } },
      { groupA: { $in: groupForms } },
      { groupB: { $in: groupForms } },
    ],
  };
  // A list never renders artwork, and an entry can carry hundreds of strokes, so
  // the pixels stay out of the sort. The pre-phase-machine documents key their
  // entries by group id instead of slot, and those are only ever visible to a
  // member of one of those groups. `order` stays in: it is a handful of user ids
  // per side, and dropping it made every turn in the feed silently null.
  const fields = { 'entries.A.strokes': 0, 'entries.B.strokes': 0 };
  for (const form of groupForms) fields[`entries.${form}.strokes`] = 0;

  const rows = await competitions.find(visible).project(fields).sort({ createdAt: -1 }).limit(input.limit || 40).toArray();
  if (!rows.length) return { active: [], recent: [] };

  // A battle nobody opens again is settled by its own listing; otherwise the feed
  // shows a result the group's played/wins counters contradict.
  await Promise.all(
    rows
      .filter((doc) => !doc.closedAt && !isLegacyBattle(doc) && phaseOf(doc, now) === 'closed')
      .map((doc) => settleBattle(doc, deps, now))
  );

  const refs = await readRefs(rows, deps);
  const summaries = rows.map((doc) => {
    const phase = phaseOf(doc, now);
    const tallied = tallyVotes(doc);
    const entries = entriesOf(doc);
    const side = mySideOf(doc, userId, refs);
    return {
      id: String(doc._id),
      kind: doc.kind || (isLegacyBattle(doc) ? 'group' : 'duel'),
      prompt: doc.prompt || '',
      createdAt: doc.createdAt || 0,
      status: phase,
      groupA: sideInfo(doc, refs, 'A'),
      groupB: sideInfo(doc, refs, 'B'),
      mySide: side,
      myGroup: side ? (side === 'A' ? doc.groupA || null : doc.groupB || null) : null,
      myStatus: participantOf(doc, userId)?.status || null,
      turn: playerTurnFor(doc, userId),
      invitesEndsAt: doc.invitesEndsAt || 0,
      drawEndsAt: doc.drawEndsAt || 0,
      voteEndsAt: doc.voteEndsAt || 0,
      drawEndTime: doc.drawEndsAt || doc.drawEndTime || 0,
      voteEndTime: doc.voteEndsAt || doc.voteEndTime || 0,
      submitted: Boolean(entries[side || 'A']?.submittedAt),
      hasVoted: Boolean(doc.votes?.[userId]),
      votes: phase === 'voting' || phase === 'closed' ? { A: tallied.A, B: tallied.B } : null,
      winner: phase === 'closed' ? tallied.winner : null,
      cancelReason: doc.cancelReason || '',
    };
  });

  return {
    active: summaries.filter((s) => !isFinalPhase(s.status)).slice(0, 12),
    recent: summaries.filter((s) => isFinalPhase(s.status)).slice(0, 12),
  };
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

function randomPrompt() {
  return BATTLE_PROMPTS[Math.floor(Math.random() * BATTLE_PROMPTS.length)];
}

function newDocument(userId, input, now, extra) {
  return {
    prompt: String(input.prompt || '').trim().slice(0, MAX_PROMPT_CHARS) || randomPrompt(),
    createdBy: userId,
    createdAt: now,
    rev: 0,
    groupA: null,
    groupB: null,
    aTitle: '',
    bTitle: '',
    participants: {},
    order: { A: [], B: [] },
    turnMs: 0,
    invitesEndsAt: now + INVITE_WINDOW_MS,
    readyEndsAt: 0,
    countdownEndsAt: 0,
    drawStartAt: 0,
    drawEndsAt: 0,
    voteEndsAt: 0,
    entries: { A: { ...EMPTY_ENTRY }, B: { ...EMPTY_ENTRY } },
    votes: {},
    winner: null,
    closedAt: 0,
    cancelledAt: 0,
    cancelReason: '',
    ...extra,
  };
}

export async function createBattle(userId, input = {}, deps = {}) {
  const now = input.now || Date.now();
  return input.kind === 'duel'
    ? createDuel(userId, input, deps, now)
    : createGroupBattle(userId, input, deps, now);
}

async function createGroupBattle(userId, input, deps, now) {
  const source = String(input.sourceGroupId || '');
  const target = String(input.targetGroupId || '');
  if (!source || !target) throw new BattleError(400, 'Pick two groups to battle.');
  if (source === target) throw new BattleError(400, 'A group cannot battle itself.');

  const groups = await collection(deps, 'groups');
  const docs = await groups.find({ _id: { $in: idIn([source, target]) } }).toArray();
  const challenger = docs.find((g) => String(g._id) === source);
  const targetDoc = docs.find((g) => String(g._id) === target);
  if (!challenger) throw new BattleError(404, 'Your group not found.');
  if (!challenger.memberIds?.includes(userId)) {
    throw new BattleError(403, 'You must be a member of the challenging group.');
  }
  if (!targetDoc) throw new BattleError(404, 'Target group not found.');

  const participants = {};
  const assign = (side, groupDoc) => {
    for (const memberId of groupDoc.memberIds || []) {
      if (participants[memberId]) continue; // someone in both groups draws once
      participants[memberId] = { side, status: memberId === userId ? 'accepted' : 'pending', readyAt: 0, submittedAt: 0 };
    }
  };
  assign('A', challenger);
  assign('B', targetDoc);

  const doc = newDocument(userId, input, now, {
    kind: 'group',
    groupA: String(challenger._id),
    groupB: String(targetDoc._id),
    aTitle: String(challenger.name || 'Group A').slice(0, MAX_TITLE_CHARS),
    bTitle: String(targetDoc.name || 'Group B').slice(0, MAX_TITLE_CHARS),
    participants,
  });
  return insert(doc, deps, now);
}

async function createDuel(userId, input, deps, now) {
  const opponentId = String(input.opponentId || '');
  if (!opponentId) throw new BattleError(400, 'Pick a friend to challenge.');
  if (opponentId === userId) throw new BattleError(400, 'You cannot battle yourself.');

  const [friendship, profiles] = await Promise.all([
    (await collection(deps, 'friendships')).findOne({
      status: 'accepted',
      $or: [{ userA: userId, userB: opponentId }, { userA: opponentId, userB: userId }],
    }),
    (await collection(deps, 'profiles')).find({ _id: { $in: [userId, opponentId] } }).toArray(),
  ]);
  if (!friendship) throw new BattleError(403, 'You can only challenge a friend.');

  const byId = new Map(profiles.map((p) => [String(p._id), p]));
  const doc = newDocument(userId, input, now, {
    kind: 'duel',
    aTitle: String(byId.get(userId)?.nickname || 'Player 1').slice(0, MAX_TITLE_CHARS),
    bTitle: String(byId.get(opponentId)?.nickname || 'Player 2').slice(0, MAX_TITLE_CHARS),
    participants: {
      [userId]: { side: 'A', status: 'accepted', readyAt: 0, submittedAt: 0 },
      [opponentId]: { side: 'B', status: 'pending', readyAt: 0, submittedAt: 0 },
    },
  });
  return insert(doc, deps, now);
}

async function insert(doc, deps, now) {
  const competitions = await collection(deps, 'competitions');
  const result = await competitions.insertOne(doc);
  return { ok: true, id: String(result.insertedId), status: phaseOf(doc, now) };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function withBattle(input, deps, now) {
  const doc = input.doc || (await findBattle(input.id, deps));
  if (!doc) throw new BattleError(404, 'Battle not found.');
  return advanceBattle(doc, deps, now);
}

export async function respond(userId, input = {}, deps = {}) {
  const now = input.now || Date.now();
  const doc = await withBattle(input, deps, now);
  const check = checkRespond(doc, userId, now);
  if (!check.ok) throw new BattleError(check.status, check.error);
  if (check.already) return { ok: true, status: 'accepted', phase: phaseOf(doc, now) };

  const competitions = await collection(deps, 'competitions');
  const status = input.accept === false ? 'declined' : 'accepted';
  const updated = await competitions.findOneAndUpdate(
    { _id: doc._id, [`participants.${userId}.status`]: 'pending' },
    {
      $set: {
        [`participants.${userId}.status`]: status,
        [`participants.${userId}.respondedAt`]: now,
      },
      $inc: { rev: 1 },
    },
    { returnDocument: 'after' }
  );
  return { ok: true, status, phase: phaseOf(updated || doc, now) };
}

export async function markReady(userId, input = {}, deps = {}) {
  const now = input.now || Date.now();
  const doc = await withBattle(input, deps, now);
  const check = checkReady(doc, userId, now);
  if (!check.ok) throw new BattleError(check.status, check.error);

  const competitions = await collection(deps, 'competitions');
  const updated = await competitions.findOneAndUpdate(
    { _id: doc._id, [`participants.${userId}.status`]: 'accepted' },
    { $set: { [`participants.${userId}.readyAt`]: now }, $inc: { rev: 1 } },
    { returnDocument: 'after' }
  );
  return { ok: true, phase: phaseOf(updated || doc, now), allReady: allAcceptedReady(updated || doc) };
}

export async function syncStrokes(userId, input = {}, deps = {}) {
  const now = input.now || Date.now();
  const invalid = validateSyncPayload(input.strokes, input.byteLength);
  if (invalid) throw new BattleError(413, invalid);

  const doc = await withBattle(input, deps, now);
  const check = checkSync(doc, userId, now);
  if (!check.ok) throw new BattleError(check.status, check.error);

  const side = check.side;
  const entryRev = doc.entries?.[side]?.rev || 0;
  const from = Number.isInteger(input.from) ? input.from : entryRev;
  // A retry of a request that already landed must not duplicate strokes.
  if (from < entryRev) return { ok: true, rev: doc.rev || 0, entryRev, deduped: true };
  if (from > entryRev) throw new BattleError(409, 'Someone just synced — reload the battle to catch up.');
  const strokeCount = doc.entries?.[side]?.strokes?.length || 0;
  if (strokeCount + input.strokes.length > MAX_STROKES_PER_ENTRY) {
    throw new BattleError(413, `A drawing holds at most ${MAX_STROKES_PER_ENTRY} strokes.`);
  }

  const competitions = await collection(deps, 'competitions');
  const updated = await competitions.findOneAndUpdate(
    { _id: doc._id, [`entries.${side}.rev`]: entryRev },
    {
      $push: { [`entries.${side}.strokes`]: { $each: input.strokes } },
      $set: { [`entries.${side}.updatedAt`]: now },
      $inc: { rev: 1, [`entries.${side}.rev`]: 1 },
    },
    { returnDocument: 'after' }
  );
  if (!updated) throw new BattleError(409, 'Someone just synced — reload the battle to catch up.');
  return {
    ok: true,
    rev: updated.rev || 0,
    entryRev: updated.entries?.[side]?.rev || entryRev + 1,
    synced: input.strokes.length,
  };
}

export async function endTurn(userId, input = {}, deps = {}) {
  const now = input.now || Date.now();
  const doc = await withBattle(input, deps, now);
  const check = checkSync(doc, userId, now);
  if (!check.ok) throw new BattleError(check.status, check.error);

  const competitions = await collection(deps, 'competitions');
  const updated = await competitions.findOneAndUpdate(
    { _id: doc._id, [`participants.${userId}.status`]: 'accepted' },
    { $set: { [`participants.${userId}.turnEndedAt`]: now }, $inc: { rev: 1 } },
    { returnDocument: 'after' }
  );
  const after = updated || doc;
  return { ok: true, next: turnWindowFor(after, check.side, check.turn.endsAt) };
}

// Strokes round-trip through JSON and through Mongo, so compare them on their
// canonical form rather than key order.
function canonicalStroke(stroke) {
  if (!stroke || typeof stroke !== 'object') return JSON.stringify(stroke ?? null);
  if (Array.isArray(stroke)) return `[${stroke.map(canonicalStroke).join(',')}]`;
  const keys = Object.keys(stroke).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStroke(stroke[k])}`).join(',')}}`;
}

export async function submitEntry(userId, input = {}, deps = {}) {
  const now = input.now || Date.now();
  const invalid = validateSyncPayload(input.strokes, input.byteLength);
  if (invalid) throw new BattleError(413, invalid);

  const doc = await withBattle(input, deps, now);
  const check = checkSubmit(doc, userId, now);
  if (!check.ok) throw new BattleError(check.status, check.error);
  if (doc.entries?.[check.side]?.submittedAt) {
    return { ok: true, submittedAt: doc.entries[check.side].submittedAt, already: true };
  }

  // A team draws on one shared canvas, so submitting it locks it in for every
  // member. A member whose client is behind — or who never received a
  // teammate's strokes — would otherwise replace the whole team's work with a
  // shorter copy of it. A submission therefore has to carry the synced strokes
  // as an unchanged prefix and may only append to them.
  const synced = doc.entries?.[check.side]?.strokes || [];
  const dropsWork = input.strokes.length < synced.length
    || synced.some((stroke, i) => canonicalStroke(stroke) !== canonicalStroke(input.strokes[i]));
  if (dropsWork) {
    throw new BattleError(409, `Your team already drew ${synced.length} stroke${synced.length === 1 ? '' : 's'} — reload the battle so you do not drop their work.`);
  }

  const competitions = await collection(deps, 'competitions');
  const updated = await competitions.findOneAndUpdate(
    { _id: doc._id, [`participants.${userId}.status`]: 'accepted', [`entries.${check.side}.submittedAt`]: 0 },
    {
      $set: {
        [`entries.${check.side}.strokes`]: input.strokes,
        [`entries.${check.side}.submittedAt`]: now,
        [`entries.${check.side}.updatedAt`]: now,
        [`entries.${check.side}.rev`]: (doc.entries?.[check.side]?.rev || 0) + 1,
        [`participants.${userId}.submittedAt`]: now,
      },
      $inc: { rev: 1 },
    },
    { returnDocument: 'after' }
  );
  if (!updated) throw new BattleError(409, 'Your entry is already locked in.');
  return { ok: true, submittedAt: now };
}

export async function castVote(userId, input = {}, deps = {}) {
  const now = input.now || Date.now();
  const doc = await withBattle(input, deps, now);
  const check = checkVote(doc, userId, now);
  if (!check.ok) throw new BattleError(check.status, check.error);
  const side = sideFor(doc, input.side ?? input.groupId);
  if (!side) throw new BattleError(400, 'Invalid vote target.');

  const competitions = await collection(deps, 'competitions');
  const result = await competitions.updateOne(
    { _id: doc._id, [`votes.${userId}`]: { $exists: false } },
    { $set: { [`votes.${userId}`]: side }, $inc: { rev: 1 } }
  );
  if (result.matchedCount !== 1) throw new BattleError(400, 'You already voted.');
  const tallied = tallyVotes(doc);
  return { ok: true, voted: side, votes: { A: tallied.A + (side === 'A' ? 1 : 0), B: tallied.B + (side === 'B' ? 1 : 0) } };
}

export async function cancelBattle(userId, input = {}, deps = {}) {
  const now = input.now || Date.now();
  const doc = await withBattle(input, deps, now);
  const check = checkCancel(doc, userId);
  if (!check.ok) throw new BattleError(check.status, check.error);

  const competitions = await collection(deps, 'competitions');
  const result = await competitions.updateOne(
    { _id: doc._id, cancelledAt: { $in: [0, null] } },
    { $set: { cancelledAt: now, cancelReason: input.reason || CANCEL_REASON.CREATOR }, $inc: { rev: 1 } }
  );
  // Nothing matched: somebody cancelled it between the read and this write, so
  // the battle is cancelled — just not by us, and not at `now`.
  if (result.matchedCount !== 1) throw new BattleError(409, 'This battle was already cancelled.');
  return { ok: true, cancelledAt: now };
}

// Every unfinished battle involving a group dies with it (the group is being
// deleted, or a member left and the roster can no longer be trusted).
export async function cancelBattlesForGroup(groupId, input = {}, deps = {}) {
  const now = input.now || Date.now();
  const competitions = await collection(deps, 'competitions');
  const result = await competitions.updateMany(
    {
      $or: [{ groupA: { $in: idIn([groupId]) } }, { groupB: { $in: idIn([groupId]) } }],
      closedAt: { $in: [0, null] },
      cancelledAt: { $in: [0, null] },
    },
    {
      $set: { cancelledAt: now, cancelReason: input.reason || CANCEL_REASON.GROUP_GONE },
      $inc: { rev: 1 },
    }
  );
  return { ok: true, cancelled: result.modifiedCount || 0 };
}
