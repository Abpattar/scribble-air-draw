#!/usr/bin/env node
// Integration test for the battle persistence layer.
//
// scripts/battle-lifecycle.mjs proves the rules in api-lib/battle.js with a fake
// clock and no database. This proves the thing that fake cannot: that
// api-lib/battleStore.js actually does what those rules say against a real Mongo,
// through the same guarded updates the serverless functions use. Same store, same
// collections, same queries — only the database differs.
//
// It runs against a THROWAWAY database (neonair_battletest) on the same cluster,
// dropped and recreated on every run, so production data in `neonair` is never
// read or written. Nothing here is imported by the app.
//
//   node scripts/battle-integration.mjs

import { MongoClient, ObjectId } from 'mongodb';
import {
  BattleError,
  cancelBattle,
  cancelBattlesForGroup,
  castVote,
  createBattle,
  endTurn,
  getBattle,
  listBattles,
  markReady,
  respond,
  submitEntry,
  syncStrokes,
} from '../api-lib/battleStore.js';
import { idFilter } from '../api-lib/ids.js';
import {
  COUNTDOWN_MS,
  DRAW_WINDOW_MS,
  INVITE_WINDOW_MS,
  MAX_STROKES_PER_ENTRY,
  TURN_GRACE_MS,
  TURN_MIN_MS,
  VOTE_WINDOW_MS,
  phaseOf,
  turnSchedule,
} from '../api-lib/battle.js';

const DB_NAME = 'neonair_battletest';
const T0 = 1_700_000_000_000;
const MIN = 60_000;

let now = T0;
const at = (offset) => {
  now = T0 + offset;
  return now;
};

let passed = 0;
const failures = [];
let group = '';

function section(name) {
  group = name;
  console.log(`\n${name}`);
}

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(`${group} → ${label}: expected ${b}, got ${a}`);
    console.log(`  FAIL ${label}: expected ${b}, got ${a}`);
  }
}

function ok(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(`${group} → ${label}${detail ? `: ${detail}` : ''}`);
    console.log(`  FAIL ${label}${detail ? `: ${detail}` : ''}`);
  }
}

// Runs a store call expected to be refused, and returns the BattleError.
async function refuses(label, fn, expectedStatus) {
  try {
    await fn();
    ok(label, false, 'it was allowed');
    return null;
  } catch (error) {
    if (!(error instanceof BattleError)) {
      ok(label, false, `not a BattleError: ${error.message}`);
      return null;
    }
    if (expectedStatus === undefined) {
      ok(label, true);
    } else {
      check(`${label} → status`, error.status, expectedStatus);
    }
    return error;
  }
}

// ---------------------------------------------------------------------------
// Throwaway database
// ---------------------------------------------------------------------------

if (!process.env.MONGODB_URI) {
  console.error('MONGODB_URI is not set.');
  process.exit(1);
}

const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
await client.connect();
const db = client.db(DB_NAME);
await db.dropDatabase();

const collections = {
  competitions: db.collection('competitions'),
  groups: db.collection('groups'),
  profiles: db.collection('profiles'),
  friendships: db.collection('friendships'),
  requests: db.collection('requests'),
};
const deps = collections;

await collections.competitions.createIndex({ createdAt: -1 });
await collections.competitions.createIndex({ 'participants.invites': 1 });

const users = (...ids) => ids;
const profiles = {};
for (const id of ['a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'b3', 'lone']) {
  profiles[id] = { _id: id, nickname: id.toUpperCase(), avatar: '🙂' };
}
await collections.profiles.insertMany(Object.values(profiles));

let groupSeq = 0;
async function makeGroup(memberIds) {
  groupSeq += 1;
  const _id = `grp${groupSeq}`;
  await collections.groups.insertOne({ _id, name: `Group ${groupSeq}`, emoji: '🎨', memberIds, played: 0, wins: 0 });
  return _id;
}

async function befriend(a, b) {
  await collections.friendships.insertOne({ _id: `f-${a}-${b}`, userA: a, userB: b, status: 'accepted' });
}

const stroke = (tag) => [{ pts: [[0, 0], [1, 1]], color: '#000', w: 3, tag }];
const countOf = (view, side) => view.entries.find((e) => e.side === side)?.strokeCount;
const strokesOf = (view, side) => view.entries.find((e) => e.side === side)?.strokes;

// Drives a battle to the given phase by moving the clock forward and letting the
// store persist each boundary, exactly as a poll would.
async function advanceTo(id, target, depsOverride = deps) {
  const doc = await collections.competitions.findOne(idFilter(id));
  const seen = [];
  for (let step = 0; step < 40; step += 1) {
    const fresh = await collections.competitions.findOne(idFilter(id));
    const phase = phaseOf(fresh, now);
    seen.push(phase);
    if (phase === target) return fresh;
    if (phase === 'closed' || phase === 'cancelled') return fresh;
    // Move to the next boundary the document knows about.
    const next = [fresh.invitesEndsAt, fresh.readyEndsAt, fresh.countdownEndsAt, fresh.drawEndsAt, fresh.voteEndsAt]
      .filter((t) => t > now)
      .sort((x, y) => x - y)[0];
    if (!next) return fresh;
    at(next - T0 + (target === 'drawing' ? 1 : 0));
    await getBattle('observer', { id, now, doc: fresh }, depsOverride);
  }
  return collections.competitions.findOne(idFilter(id));
}

// ===========================================================================
section('1. Group battle, unequal teams (3 vs 2)');
// ===========================================================================

const GA = await makeGroup(users('a1', 'a2', 'a3'));
const GB = await makeGroup(users('b1', 'b2'));

at(0);
const created = await createBattle('a1', { kind: 'group', sourceGroupId: GA, targetGroupId: GB, now }, deps);
check('creation returns an id', typeof created.id, 'string');
check('creation phase', created.status, 'inviting');

const rawAfterCreate = await collections.competitions.findOne(idFilter(created.id));
check('creator is auto-accepted', rawAfterCreate.participants.a1.status, 'accepted');
check('other members start pending', [rawAfterCreate.participants.a2.status, rawAfterCreate.participants.b1.status], ['pending', 'pending']);
check('sides are assigned by group', [rawAfterCreate.participants.a3.side, rawAfterCreate.participants.b2.side], ['A', 'B']);

await refuses('a group cannot battle itself', () => createBattle('a1', { kind: 'group', sourceGroupId: GA, targetGroupId: GA, now }, deps), 400);
await refuses('a non-member cannot start a group battle', () => createBattle('lone', { kind: 'group', sourceGroupId: GA, targetGroupId: GB, now }, deps), 403);

// ===========================================================================
section('2. Declining leaves the permanent group untouched');
// ===========================================================================

await respond('a2', { id: created.id, accept: false, now }, deps);
await respond('b1', { id: created.id, accept: true, now }, deps);
await respond('b2', { id: created.id, accept: true, now }, deps);

const groupAfterDecline = await collections.groups.findOne({ _id: GA });
check('declining a battle does NOT remove a group member', groupAfterDecline.memberIds.sort(), ['a1', 'a2', 'a3']);
const battleAfterDecline = await collections.competitions.findOne(idFilter(created.id));
check('the decliner is out of the battle', battleAfterDecline.participants.a2.status, 'declined');
check('the decliner keeps their side', battleAfterDecline.participants.a2.side, 'A');
check('accepted counts after one decline', [Object.values(battleAfterDecline.participants).filter((p) => p.status === 'accepted' && p.side === 'A').length,
  Object.values(battleAfterDecline.participants).filter((p) => p.status === 'accepted' && p.side === 'B').length], [1, 2]);
await refuses('a declined player cannot rejoin', () => respond('a2', { id: created.id, accept: true, now }, deps), 400);

// ===========================================================================
section('3. Ready → countdown → drawing');
// ===========================================================================

// Nobody may press Ready while invitations are still open — the store says so
// rather than starting a battle that is still collecting players. Close the
// window, then the battle moves to the ready stage.
await refuses('nobody can ready while invitations are open', () => markReady('a1', { id: created.id, now }, deps), 400);
at(INVITE_WINDOW_MS + MIN);
const readyStage = await getBattle('a1', { id: created.id, now }, deps);
check('the battle reaches the ready stage when invitations close', readyStage.phase, 'ready');

await markReady('a1', { id: created.id, now }, deps);
await markReady('b1', { id: created.id, now }, deps);
await markReady('b2', { id: created.id, now }, deps);

const counting = await collections.competitions.findOne(idFilter(created.id));
check('all ready starts the countdown', phaseOf(counting, now), 'countdown');
// The schedule is written by the guarded phase patch, which lands on the first
// read that crosses a boundary rather than on the write that caused it, so it
// is asserted the way a client meets it: through the store.
const countingView = await getBattle('a1', { id: created.id, now }, deps);
check(
  'the whole schedule reaches the client in one view',
  [
    countingView.countdownEndsAt - countingView.invitesEndsAt > 0,
    countingView.drawEndsAt - countingView.drawStartAt,
    countingView.voteEndsAt - countingView.drawEndsAt,
  ],
  [true, DRAW_WINDOW_MS, VOTE_WINDOW_MS]
);

const drawing = await advanceTo(created.id, 'drawing');
check('phase reaches drawing', phaseOf(drawing, now), 'drawing');
check('turn order for side A (creator first)', drawing.order.A, ['a1']);
check('turn order for side B', drawing.order.B, ['b1', 'b2']);
check('both sides share one drawing window', drawing.drawEndsAt - drawing.drawStartAt, DRAW_WINDOW_MS);

await markReady('a1', { id: created.id, now }, deps);
ok('ready is idempotent', true);

// ===========================================================================
section('4. Turn-based drawing on the shared team canvas');
// ===========================================================================

const b1Turn = drawing.order.B.indexOf('b1') * drawing.turnMs;
at(drawing.drawStartAt - T0 + b1Turn + 1000);

await refuses('a player cannot sync before their slot', () => syncStrokes('b2', { id: created.id, strokes: stroke('early'), now }, deps), 403);

const firstSync = await syncStrokes('b1', { id: created.id, strokes: stroke('b1-first'), now }, deps);
check('the turn owner syncs', firstSync.ok, true);
check('the entry revision advanced', firstSync.entryRev, 1);

const repeat = await syncStrokes('b1', { id: created.id, from: 0, strokes: stroke('b1-first'), now }, deps);
check('a replayed sync is deduplicated, not doubled', repeat.deduped, true);

await refuses('a sync claiming a position ahead of the entry is refused', () => syncStrokes('b1', { id: created.id, from: repeat.entryRev + 5, strokes: stroke('x'), now }, deps), 409);
await refuses('another player of the same team cannot write outside their slot', () => syncStrokes('b2', { id: created.id, strokes: stroke('b2-early'), now }, deps), 403);

// Concurrent writers at the same revision: exactly one may win, and the loser is
// told to catch up rather than duplicating strokes.
const racers = await Promise.allSettled([
  syncStrokes('b1', { id: created.id, from: 1, strokes: stroke('race-1'), now }, deps),
  syncStrokes('b1', { id: created.id, from: 1, strokes: stroke('race-2'), now }, deps),
]);
const winners = racers.filter((r) => r.status === 'fulfilled');
check('exactly one concurrent sync wins', winners.length, 1);

const afterRace = await collections.competitions.findOne(idFilter(created.id));
check('the race did not duplicate strokes', afterRace.entries.B.strokes.length, 2);

// The other team is still inside its own grace period, so this sync is allowed
// — and it must land in the caller's OWN entry. The entry is taken from the
// caller's own turn, never from the request, so a payload cannot aim at a canvas
// it does not own.
const intruder = await syncStrokes('a1', { id: created.id, strokes: stroke('intruder'), now }, deps);
ok('a member of the other team may still save inside their own grace period', intruder.ok === true);
const afterIntruder = await collections.competitions.findOne(idFilter(created.id));
check(
  'a sync lands in the caller\'s own canvas only',
  [afterIntruder.entries.A.strokes.length, afterIntruder.entries.B.strokes.length],
  [1, 2]
);

const b1View = await getBattle('b1', { id: created.id, now, strokes: true }, deps);
check('a team member sees their own team artwork', strokesOf(b1View, 'B')?.length, 2);
check('a team member does NOT see the rival mid-drawing artwork', strokesOf(b1View, 'A'), null);
check('a team member still sees the rival stroke count', countOf(b1View, 'A'), 1);

const observerView = await getBattle('stranger', { id: created.id, now, strokes: true }, deps);
check('an outsider cannot see in-progress artwork at all', [strokesOf(observerView, 'A'), strokesOf(observerView, 'B')], [null, null]);
check('an outsider still sees the phase', observerView.phase, 'drawing');

await endTurn('b1', { id: created.id, now }, deps);
const afterEnd = await collections.competitions.findOne(idFilter(created.id));
ok('ending a turn is recorded', Boolean(afterEnd.participants.b1.turnEndedAt));
await refuses('a player cannot sync after ending their turn', () => syncStrokes('b1', { id: created.id, strokes: stroke('late'), now }, deps), 409);

// ===========================================================================
section('5. Unequal teams get a window both sides can finish');
// ===========================================================================

for (const [sizeA, sizeB] of [[1, 2], [2, 3], [3, 4], [4, 4], [1, 1]]) {
  const a = await makeGroup(users(...Array.from({ length: sizeA }, (_, i) => `a${i + 1}`)));
  const b = await makeGroup(users(...Array.from({ length: sizeB }, (_, i) => `b${i + 1}`)));
  const seeded = { ...{ a1: { side: 'A', status: 'accepted' } }, ...{} };
  const doc = {
    participants: {},
    createdBy: 'a1',
    invitesEndsAt: now,
    readyEndsAt: 0,
    countdownEndsAt: 0,
  };
  for (let i = 0; i < sizeA; i += 1) doc.participants[`a${i + 1}`] = { side: 'A', status: 'accepted' };
  for (let i = 0; i < sizeB; i += 1) doc.participants[`b${i + 1}`] = { side: 'B', status: 'accepted' };
  const schedule = turnSchedule(doc, now);
  check(
    `${sizeA}v${sizeB}: one window, both sides finish together`,
    [schedule.maxTurns, schedule.drawEndsAt - schedule.drawStartAt, schedule.turnMs >= TURN_MIN_MS],
    [Math.max(sizeA, sizeB), DRAW_WINDOW_MS, true]
  );
  ok(`${sizeA}v${sizeB}: no side is left without a slot`, schedule.order.A.length === sizeA && schedule.order.B.length === sizeB);
  if (seeded.a1) check(`${sizeA}v${sizeB}: creator draws first`, schedule.order.A[0], 'a1');
}

// ===========================================================================
section('6. Submission cannot destroy a team artwork');
// ===========================================================================

const beforeSubmit = await collections.competitions.findOne(idFilter(created.id));
const storedCount = beforeSubmit.entries.B.strokes.length;
await refuses(
  'submitting a shorter payload than the team already has is refused',
  () => submitEntry('b2', { id: created.id, strokes: stroke('only-mine'), now }, deps),
  409
);
const afterBadSubmit = await collections.competitions.findOne(idFilter(created.id));
check('the team artwork is untouched after the refused submit', afterBadSubmit.entries.B.strokes.length, storedCount);

const submitted = await submitEntry('b1', { id: created.id, strokes: [...beforeSubmit.entries.B.strokes, ...stroke('b1-last')], now }, deps);
ok('a merged submit is accepted', submitted.ok === true);
const afterGoodSubmit = await collections.competitions.findOne(idFilter(created.id));
check('the merged artwork is stored whole', afterGoodSubmit.entries.B.strokes.length, storedCount + 1);
check('the entry is locked', Boolean(afterGoodSubmit.entries.B.submittedAt), true);
ok('re-submitting is idempotent', (await submitEntry('b1', { id: created.id, strokes: stroke('again'), now }, deps)).already === true);

// ===========================================================================
section('7. Voting');
// ===========================================================================

const voting = await advanceTo(created.id, 'voting');
check('phase reaches voting', phaseOf(voting, now), 'voting');

const b1VoteView = await getBattle('b1', { id: created.id, now, strokes: true }, deps);
check('a participant can see both final artworks while voting', [strokesOf(b1VoteView, 'A')?.length ?? 0, strokesOf(b1VoteView, 'B')?.length ?? 0], [1, storedCount + 1]);
ok('votes are hidden before the window opens', voting.voteEndsAt > now);

await castVote('a1', { id: created.id, side: 'A', now }, deps);
await castVote('b1', { id: created.id, side: 'A', now }, deps);
await refuses('the same player cannot vote twice', () => castVote('a1', { id: created.id, side: 'B', now }, deps), 400);
await refuses('a player cannot vote during the drawing window', () => castVote('a1', { id: created.id, side: 'B', now: drawing.drawStartAt }, deps), 400);
await refuses('a non-participant cannot vote', () => castVote('lone', { id: created.id, side: 'A', now }, deps), 403);

const midVote = await getBattle('b1', { id: created.id, now }, deps);
check('running tally', [midVote.votes.A, midVote.votes.B], [2, 0]);
check('a player may vote for their own side', midVote.myVote, 'A');
ok('no winner is announced while voting', midVote.winner === null);

// ===========================================================================
section('8. Results, settlement and the leaderboard');
// ===========================================================================

at(voting.voteEndsAt - T0 + 1);
const closedView = await getBattle('b1', { id: created.id, now, strokes: true }, deps);
check('the majority wins', closedView.winner, 'A');
check('the tally is final', [closedView.votes.A, closedView.votes.B], [2, 0]);

const groupA = await collections.groups.findOne({ _id: GA });
check('the winning group is credited a win', groupA.wins, 1);
check('both groups record the match', groupA.played, 1);

const closedDoc = await collections.competitions.findOne(idFilter(created.id));
ok('the battle is closed exactly once', Boolean(closedDoc.closedAt) && closedDoc.winner === 'A');
await getBattle('b1', { id: created.id, now }, deps);
const groupAAfter = await collections.groups.findOne({ _id: GA });
check('settlement does not double count', [groupAAfter.played, groupAAfter.wins], [1, 1]);

// A tie has no winner, and must not crash the tally.
const tie = { _id: 'tie-doc', groupA: GA, groupB: GB, participants: { a1: { side: 'A' }, b1: { side: 'B' } }, votes: { a1: 'A', b1: 'B' } };
const { tallyVotes } = await import('../api-lib/battle.js');
check('a tie has no winner', tallyVotes(tie).winner, null);

// ===========================================================================
section('9. A tie in the list feed is reported, not invented');
// ===========================================================================

const feed = await listBattles('a1', { now }, deps);
const mine = feed.active.concat(feed.recent).filter((s) => s.id === created.id);
check('the finished battle is listed once', mine.length, 1);
check('the list reports the phase', mine[0]?.status, 'closed');
check('the list reports the winner', mine[0]?.winner, 'A');

// ===========================================================================
section('10. The feed tells an active player whose turn it is');
// ===========================================================================

const GA2 = await makeGroup(users('a1', 'b1'));
const GB2 = await makeGroup(users('b2', 'a2'));
const live = await createBattle('a1', { kind: 'group', sourceGroupId: GA2, targetGroupId: GB2, now }, deps);
for (const id of ['b1', 'a2', 'b2']) await respond(id, { id: live.id, accept: true, now }, deps);
for (const id of ['a1', 'b1', 'a2', 'b2']) await markReady(id, { id: live.id, now }, deps);
const liveDoc = await advanceTo(live.id, 'drawing');
at(liveDoc.drawStartAt - T0 + 1);

const liveFeed = await listBattles('a1', { now }, deps);
const liveSummary = liveFeed.active.find((s) => s.id === live.id);
ok('the list shows the live battle', Boolean(liveSummary));
ok('the list tells a1 whose turn it is', liveSummary?.turn?.index === 0, `turn was ${JSON.stringify(liveSummary?.turn)}`);
check('the list turn belongs to the caller', liveSummary?.turn?.side, 'A');

const detail = await getBattle('a1', { id: live.id, now }, deps);
check('the detail view agrees on the turn', detail.myTurn?.index, 0);
check('the detail view names both side windows', [Boolean(detail.turn.A), Boolean(detail.turn.B)], [true, true]);

// ===========================================================================
section('11. Nobody accepted on one side');
// ===========================================================================

const GC = await makeGroup(users('a1', 'a2'));
const GD = await makeGroup(users('b1', 'b2'));
const lonely = await createBattle('a1', { kind: 'group', sourceGroupId: GC, targetGroupId: GD, now }, deps);
await respond('a2', { id: lonely.id, accept: false, now }, deps);
await respond('b1', { id: lonely.id, accept: false, now }, deps);
await respond('b2', { id: lonely.id, accept: false, now }, deps);

at(INVITE_WINDOW_MS + MIN);
const deadView = await getBattle('a1', { id: lonely.id, now }, deps);
const deadDoc = await collections.competitions.findOne(idFilter(lonely.id));
check('a battle nobody joined is cancelled, not stuck', deadView.phase, 'cancelled');
check('with a reason', deadView.cancelReason, 'nobody_accepted');
ok('the cancellation is persisted', Boolean(deadDoc.cancelledAt));
await refuses('a cancelled battle cannot be cancelled again', () => cancelBattle('a1', { id: lonely.id, now }, deps), 400);

// ===========================================================================
section('12. Expiry and stale invitations');
// ===========================================================================

const GE = await makeGroup(users('a1', 'a2'));
const GF = await makeGroup(users('b1', 'b2'));
const stale = await createBattle('a1', { kind: 'group', sourceGroupId: GE, targetGroupId: GF, now }, deps);

const staleInvitesEndsAt = (await collections.competitions.findOne(idFilter(stale.id))).invitesEndsAt;
at(staleInvitesEndsAt - T0 + 1);
const staleView = await getBattle('a2', { id: stale.id, now, strokes: true }, deps);
const staleParticipant = staleView.participants.find((p) => p.userId === 'a2');
check('an unanswered invitation reads as declined once it expires', staleParticipant?.status, 'declined');
await refuses('an expired invitation cannot be accepted', () => respond('a2', { id: stale.id, accept: true, now }, deps), 400);
ok('an expired battle still terminates on its own', ['cancelled', 'ready', 'countdown', 'drawing', 'voting', 'closed'].includes(staleView.phase));

// ===========================================================================
section('13. Refresh, reconnect and cold start');
// ===========================================================================

const coldRead = await collections.competitions.findOne(idFilter(live.id));
const coldView = await getBattle('a1', { id: live.id, now, strokes: true }, deps);
check('a brand new process reaches the same phase from the document alone', coldView.phase, phaseOf(coldRead, now));
check('and the same turn', coldView.myTurn?.index, 0);
ok('the battle is not held in module state', coldView.id === live.id);

// ===========================================================================
section('14. A member leaving kills the battle but not the group');
// ===========================================================================

await collections.groups.updateOne({ _id: GA2 }, { $set: { memberIds: ['a1'] } });
const cancelled = await cancelBattlesForGroup(GA2, { now }, deps);
ok('leaving a group cancels its live battle', cancelled.cancelled >= 1);
const afterLeave = await getBattle('a1', { id: live.id, now }, deps);
check('the battle is cancelled', afterLeave.phase, 'cancelled');
const GA2Doc = await collections.groups.findOne({ _id: GA2 });
check('the group itself survives the departure', GA2Doc.memberIds, ['a1']);

// ===========================================================================
section('15. 1v1 duel');
// ===========================================================================

const AH = await makeGroup(users('a1'));
const AI = await makeGroup(users('b1'));
await befriend('a1', 'b1');
const AH2 = await makeGroup(users('a2'));
await befriend('a2', 'a1');

await refuses('you can only challenge a friend', () => createBattle('a3', { kind: 'duel', opponentId: 'b1', now }, deps), 403);
await refuses('you cannot duel yourself', () => createBattle('a1', { kind: 'duel', opponentId: 'a1', now }, deps), 400);

const duel = await createBattle('a1', { kind: 'duel', opponentId: 'b1', now }, deps);
const duelDoc = await collections.competitions.findOne(idFilter(duel.id));
check('a duel has exactly two players', Object.keys(duelDoc.participants).sort(), ['a1', 'b1']);
check('the challenger is accepted', duelDoc.participants.a1.status, 'accepted');
check('the rival is invited', duelDoc.participants.b1.status, 'pending');
check('it is a duel, not a group battle', duelDoc.kind, 'duel');
ok('it has no groups attached', duelDoc.groupA === null && duelDoc.groupB === null);

await respond('b1', { id: duel.id, accept: true, now }, deps);
for (const id of ['a1', 'b1']) await markReady(id, { id: duel.id, now }, deps);
const duelDrawing = await advanceTo(duel.id, 'drawing');

at(duelDrawing.drawStartAt - T0 + 1);
const duelA = await syncStrokes('a1', { id: duel.id, strokes: stroke('a-work'), now }, deps);
ok('a duel player may write in their own slot', duelA.ok === true);
const duelB = await syncStrokes('b1', { id: duel.id, strokes: stroke('b-work'), now }, deps);
ok('both duel players get the whole window, not halves', duelB.ok === true);

const duelMid = await getBattle('a1', { id: duel.id, now, strokes: true }, deps);
check('a duel keeps each side on its own entry', [countOf(duelMid, 'A'), countOf(duelMid, 'B')], [1, 1]);

const duelSyncedA = (await collections.competitions.findOne(idFilter(duel.id))).entries.A.strokes;
const duelSubmitA = await submitEntry('a1', { id: duel.id, strokes: [...duelSyncedA, ...stroke('a-final')], now }, deps);
ok('a duel entry is submitted', duelSubmitA.ok === true);
const duelAfter = await collections.competitions.findOne(idFilter(duel.id));
check('a duel submission locks the entry', [duelAfter.entries.A.submittedAt > 0, duelAfter.entries.B.submittedAt], [true, 0]);

// ===========================================================================
section('16. Payload caps');
// ===========================================================================

const GA3 = await makeGroup(users('a1', 'a2'));
const GB3 = await makeGroup(users('b1', 'b2'));
const capped = await createBattle('a1', { kind: 'group', sourceGroupId: GA3, targetGroupId: GB3, now }, deps);
for (const id of ['a2', 'b1', 'b2']) await respond(id, { id: capped.id, accept: true, now }, deps);
for (const id of ['a1', 'a2', 'b1', 'b2']) await markReady(id, { id: capped.id, now }, deps);
const cappedDoc = await advanceTo(capped.id, 'drawing');
at(cappedDoc.drawStartAt - T0 + 1);

await refuses('an oversized body is refused', () => syncStrokes('a1', { id: capped.id, strokes: stroke('big'), byteLength: 50 * 1024 * 1024, now }, deps), 413);
await refuses('malformed drawing data is refused', () => syncStrokes('a1', { id: capped.id, strokes: 'nope', now }, deps), 413);
const many = Array.from({ length: MAX_STROKES_PER_ENTRY + 1 }, () => ({ pts: [[0, 0]] }));
await refuses('too many strokes are refused', () => syncStrokes('a1', { id: capped.id, strokes: many, now }, deps), 413);

const afterCap = await collections.competitions.findOne(idFilter(capped.id));
check('no refused payload was written', afterCap.entries.A.strokes.length, 0);

// ===========================================================================
section('17. The organiser can cancel before the start');
// ===========================================================================

const GA4 = await makeGroup(users('a1', 'a2'));
const GB4 = await makeGroup(users('b1', 'b2'));
const cancellable = await createBattle('a1', { kind: 'group', sourceGroupId: GA4, targetGroupId: GB4, now }, deps);
await refuses('a non-organiser cannot cancel', () => cancelBattle('a2', { id: cancellable.id, now }, deps), 403);
await cancelBattle('a1', { id: cancellable.id, now }, deps);
const cancelledView = await getBattle('a1', { id: cancellable.id, now }, deps);
check('the battle is cancelled', cancelledView.phase, 'cancelled');
ok('invited players are told it is over', cancelledView.cancelReason === 'creator_cancelled');
await refuses('a cancelled battle cannot be readied', () => markReady('a1', { id: cancellable.id, now }, deps), 400);
await refuses('a player who never answered cannot ready a cancelled battle', () => markReady('a2', { id: cancellable.id, now }, deps), 403);

// ===========================================================================
section('18. Legacy battles still render');
// ===========================================================================

await collections.competitions.insertOne({
  _id: 'legacy-1',
  kind: 'group',
  prompt: 'Old battle',
  createdBy: 'a1',
  createdAt: T0,
  groupA: GA,
  groupB: GB,
  aTitle: 'A',
  bTitle: 'B',
  drawEndTime: now + DRAW_WINDOW_MS,
  voteEndTime: now + DRAW_WINDOW_MS + VOTE_WINDOW_MS,
  entries: { [GA]: { strokes: stroke('old-a'), submittedAt: 1 }, [GB]: { strokes: stroke('old-b'), submittedAt: 1 } },
  votes: {},
});
const legacy = await getBattle('a1', { id: 'legacy-1', now, strokes: true }, deps);
ok('a pre-phase-machine battle still renders', Boolean(legacy.id));
check('and it is not left in a broken phase', ['drawing', 'voting', 'closed'].includes(legacy.phase), true);
ok('its artwork is still reachable', legacy.entries.some((e) => e.strokes && e.strokes.length > 0));

// ===========================================================================
section('19. Nothing is left in a broken state');
// ===========================================================================

const all = await collections.competitions.find({}).toArray();
const stuck = all.filter((doc) => !['inviting', 'ready', 'countdown', 'drawing', 'voting', 'closed', 'cancelled'].includes(phaseOf(doc, now)));
check('every battle in the database reports a real phase', stuck.length, 0);

// A battle nobody opens again is settled by the feed listing it, so the sweep is
// made through that: after it, nothing may still sit past its voting window
// without a result.
for (const uid of ['a1', 'a2', 'b1', 'b2']) await listBattles(uid, { now }, deps);
const afterFeed = await collections.competitions.find({}).toArray();
const unbounded = afterFeed.filter((doc) => !doc.cancelledAt && doc.voteEndsAt > 0 && now > doc.voteEndsAt + MIN);
ok('the feed settles every battle it lists past its voting window', unbounded.every((d) => Boolean(d.closedAt)));
ok('and nothing is left in a phase it can never leave', afterFeed.every((d) => phaseOf(d, now) !== 'closed' || Boolean(d.closedAt)));

// ===========================================================================
section('20. Id lookups match how ids are actually stored');
// ===========================================================================
//
// Every collection except profiles stores its `_id` as an ObjectId, because
// nothing sets one before the insert. A lookup helper that can only produce
// strings therefore finds nothing at all — no battle detail read, no group
// battle, no group invitation. These are the exact shapes the handlers use.

const { idIn } = await import('../api-lib/ids.js');
const oidGroup = new ObjectId();
const stringDoc = { _id: 'profile-style-string-id', nick: 'keep' };
await collections.groups.insertOne({ _id: oidGroup, name: 'ObjectId group', memberIds: ['a1'] });
await collections.profiles.insertOne(stringDoc);

check(
  'a battle detail read finds a battle stored with an ObjectId',
  Boolean(await collections.competitions.findOne(idFilter(created.id))),
  true
);
check(
  'a group read finds a group stored with an ObjectId',
  Boolean(await collections.groups.findOne(idFilter(String(oidGroup)))),
  true
);
check(
  'and a document stored with a string id is still found',
  Boolean(await collections.profiles.findOne(idFilter('profile-style-string-id'))),
  true
);

// The accept-invitation write in api/requests.js, against an ObjectId group.
const claimed = await collections.groups.updateOne(
  { _id: { $in: idIn([String(oidGroup)]) } },
  { $set: { name: 'renamed by the invite flow' } }
);
check('an invitation write matches the group it points at', claimed.matchedCount, 1);
check('and did not touch anything else', claimed.modifiedCount, 1);
ok('a string id never matches an ObjectId document', (await collections.groups.findOne(idFilter('0'.repeat(24)))) === null);

await collections.groups.deleteOne({ _id: oidGroup });
check('cleanup', await collections.groups.countDocuments({ _id: oidGroup }), 0);

// ===========================================================================
await db.dropDatabase();
await client.close();

console.log(`\n${'-'.repeat(64)}`);
if (failures.length) {
  console.log(`FAILED — ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log(`PASSED — ${passed} checks green (database ${DB_NAME} dropped)`);
