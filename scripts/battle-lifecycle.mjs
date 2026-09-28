#!/usr/bin/env node
// Dependency-free lifecycle test for the battle phase machine.
//
// It drives api-lib/battle.js — the pure rules module, with a fake clock — through
// every phase of a duel and of a group battle with unequal teams, plus the
// permission matrix, the payload caps and the invitation/ready timeouts, and
// runs the real view from api-lib/battleStore.js over those same documents to
// check what a caller is actually sent. Every assertion is "read the same
// document at a later time", which is exactly what a refresh, a reconnect or a
// cold start does, so a phase can never depend on anything the server was
// holding in memory.
//
//   node scripts/battle-lifecycle.mjs

import { readFileSync } from 'node:fs';
import {
  COUNTDOWN_MS,
  DRAW_WINDOW_MS,
  INVITE_WINDOW_MS,
  MAX_IMGSRC_CHARS,
  MAX_POINTS_PER_STROKE,
  MAX_STROKES_PER_ENTRY,
  MAX_SYNC_BODY_BYTES,
  READY_WINDOW_MS,
  TURN_GRACE_MS,
  TURN_MIN_MS,
  VOTE_WINDOW_MS,
  canSeeStrokes,
  checkCancel,
  checkReady,
  checkRespond,
  checkSubmit,
  checkSync,
  checkVote,
  isLegacyBattle,
  phaseOf,
  phasePatch,
  pickTurnOrder,
  playerTurnFor,
  readyEndsAtOf,
  sideFor,
  tallyVotes,
  turnIndexFor,
  turnWindowFor,
  validateSyncPayload,
} from '../api-lib/battle.js';
import { BattleError, battleView, cancelBattle, listBattles } from '../api-lib/battleStore.js';

const T0 = 1_700_000_000_000;
const MIN = 60_000;

let now = T0;
const clock = (ms) => {
  now = ms;
  return ms;
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

// Builds a document exactly the way api-lib/battleStore.js inserts one.
function makeDoc({ kind = 'group', createdBy, sides, invitesEndsAt = 0 }) {
  const participants = {};
  for (const [side, ids] of Object.entries(sides)) {
    for (const id of ids) {
      participants[id] = {
        side,
        status: id === createdBy ? 'accepted' : 'pending',
        readyAt: 0,
        submittedAt: 0,
      };
    }
  }
  return {
    _id: 'battle-1',
    kind,
    prompt: 'Draw a dragon made of clouds',
    createdBy,
    createdAt: T0,
    rev: 0,
    groupA: kind === 'group' ? 'group-a' : null,
    groupB: kind === 'group' ? 'group-b' : null,
    aTitle: 'A',
    bTitle: 'B',
    participants,
    order: { A: [], B: [] },
    turnMs: 0,
    invitesEndsAt: invitesEndsAt || T0 + INVITE_WINDOW_MS,
    readyEndsAt: 0,
    countdownEndsAt: 0,
    drawStartAt: 0,
    drawEndsAt: 0,
    voteEndsAt: 0,
    entries: {
      A: { strokes: [], updatedAt: 0, submittedAt: 0, rev: 0 },
      B: { strokes: [], updatedAt: 0, submittedAt: 0, rev: 0 },
    },
    votes: {},
    winner: null,
    closedAt: 0,
    cancelledAt: 0,
    cancelReason: '',
  };
}

const accept = (doc, id) => {
  doc.participants[id] = { ...doc.participants[id], status: 'accepted' };
};
const decline = (doc, id) => {
  doc.participants[id] = { ...doc.participants[id], status: 'declined' };
};
const readyUp = (doc, id) => {
  doc.participants[id] = { ...doc.participants[id], readyAt: T0 + 1000 };
};

// Applies whatever phase boundary the document has reached, the way the store
// does, so the next read sees a persisted document.
function advance(doc, at = now) {
  const patch = phasePatch(doc, at);
  if (!patch) return doc;
  Object.assign(doc, patch.set);
  return doc;
}

// ---------------------------------------------------------------------------
// A throwaway in-memory collection, so the store's *guarded writes* are
// reachable too: whether a filter actually matches the document it was written
// against, and whether a read really is scoped and projected, is a question
// about the query, not about the rules. Only the operators the store's own
// guards use are implemented, with Mongo's own "a missing field is a null"
// rule for $in.
// ---------------------------------------------------------------------------

const key = (doc, path) => path.split('.').reduce((cur, k) => (cur === undefined || cur === null ? undefined : cur[k]), doc);

function sameValue(a, b) {
  if (a === b) return true;
  if (a === undefined || a === null || b === undefined || b === null) return false;
  return String(a) === String(b); // an ObjectId and its hex string are one id
}

function matches(doc, filter = {}) {
  for (const [path, want] of Object.entries(filter)) {
    if (path === '$or' || path === '$and') {
      const any = path === '$or';
      if (!want[any ? 'some' : 'every']((sub) => matches(doc, sub))) return false;
      continue;
    }
    const value = key(doc, path);
    if (want !== null && typeof want === 'object' && !Array.isArray(want)) {
      for (const [op, arg] of Object.entries(want)) {
        if (op === '$exists' && Boolean(value) !== arg) return false;
        else if (op === '$in' && !arg.some((v) => sameValue(v, value ?? null))) return false;
        else if (op === '$ne' && sameValue(value, arg)) return false;
        else if (op === '$gt' && !(value > arg)) return false;
        else if (op === '$lte' && !(value <= arg)) return false;
      }
      continue;
    }
    if (!sameValue(value, want)) return false;
  }
  return true;
}

function project(doc, fields) {
  const out = structuredClone(doc);
  if (!fields) return out;
  for (const [path, val] of Object.entries(fields)) {
    if (val !== 0) continue; // the store only ever excludes
    const parts = path.split('.');
    const parent = parts.slice(0, -1).reduce((cur, k) => cur?.[k], out);
    if (parent) delete parent[parts[parts.length - 1]];
  }
  return out;
}

function applyUpdate(row, update) {
  for (const [op, payload] of Object.entries(update)) {
    for (const [path, value] of Object.entries(payload)) {
      const parts = path.split('.');
      const parent = parts.slice(0, -1).reduce((cur, k) => {
        if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
        return cur[k];
      }, row);
      const leaf = parts[parts.length - 1];
      if (op === '$set') parent[leaf] = structuredClone(value);
      else if (op === '$inc') parent[leaf] = (parent[leaf] || 0) + value;
      else if (op === '$push') parent[leaf] = [...(parent[leaf] || []), ...(value?.$each || [value])];
    }
  }
}

function fakeCollection(docs = []) {
  const log = { finds: [], projections: [], sorts: [], limits: [] };
  const api = {
    log,
    docs,
    find(filter = {}, options = {}) {
      log.finds.push({ filter, projection: options.projection });
      const state = { projection: options.projection, sort: null, limit: null };
      const chain = {
        project(fields) {
          state.projection = fields;
          log.projections.push(fields);
          return chain;
        },
        sort(spec) {
          state.sort = spec;
          log.sorts.push(spec);
          return chain;
        },
        limit(n) {
          state.limit = n;
          log.limits.push(n);
          return chain;
        },
        async toArray() {
          const rows = docs.filter((d) => matches(d, filter)).map((d) => project(d, state.projection));
          if (state.sort) {
            const [[field, dir]] = Object.entries(state.sort);
            rows.sort((a, b) => ((key(a, field) || 0) - (key(b, field) || 0)) * (dir < 0 ? -1 : 1));
          }
          return state.limit ? rows.slice(0, state.limit) : rows;
        },
      };
      return chain;
    },
    async findOne(filter = {}) {
      return docs.find((d) => matches(d, filter)) || null;
    },
    async updateOne(filter, update) {
      const row = docs.find((d) => matches(d, filter));
      if (!row) return { matchedCount: 0, modifiedCount: 0 };
      applyUpdate(row, update);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async updateMany(filter, update) {
      const hit = docs.filter((d) => matches(d, filter));
      for (const row of hit) applyUpdate(row, update);
      return { matchedCount: hit.length, modifiedCount: hit.length };
    },
    async bulkWrite(ops = []) {
      for (const op of ops) await api.updateOne(op.updateOne.filter, op.updateOne.update);
    },
  };
  return api;
}

const readSource = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
section('1. Duel — inviting → ready → countdown → drawing → voting → closed');
// ---------------------------------------------------------------------------

const duel = makeDoc({ kind: 'duel', createdBy: 'p1', sides: { A: ['p1'], B: ['p2'] } });
clock(T0);
check('starts in inviting', phaseOf(duel, now), 'inviting');
check('p2 may answer', checkRespond(duel, 'p2', now).ok, true);
check('a stranger may not answer', checkRespond(duel, 'outsider', now).status, 403);
check('the organiser may not sync before the start', checkSync(duel, 'p1', now).status, 400);

accept(duel, 'p2');
clock(T0 + 1000);
check('everyone answered early → ready', phaseOf(duel, now), 'ready');
const readyDeadline = readyEndsAtOf(duel, now);
check('ready window starts now', readyDeadline, T0 + 1000 + READY_WINDOW_MS);

readyUp(duel, 'p1');
readyUp(duel, 'p2');
check('all ready → countdown', phaseOf(duel, now), 'countdown');
advance(duel);
check('countdown persisted', duel.countdownEndsAt, T0 + 1000 + COUNTDOWN_MS);
check('turn order frozen', duel.order, { A: ['p1'], B: ['p2'] });
check('one player per side gets the whole window', duel.turnMs, DRAW_WINDOW_MS);
check('drawing ends a full window later', duel.drawEndsAt, duel.countdownEndsAt + DRAW_WINDOW_MS);
check('voting opens when drawing ends', duel.voteEndsAt, duel.drawEndsAt + VOTE_WINDOW_MS);
check('still countdown', phaseOf(duel, now), 'countdown');

clock(duel.countdownEndsAt);
check('countdown ends → drawing', phaseOf(duel, now), 'drawing');
check('p1 owns turn 0', turnWindowFor(duel, 'A', now).userId, 'p1');
check('p2 owns turn 0', turnWindowFor(duel, 'B', now).userId, 'p2');
check('p1 may sync on their turn', checkSync(duel, 'p1', now).ok, true);
check('p2 may not vote during drawing', checkVote(duel, 'p2', now).status, 400);
check('p1 may submit during drawing', checkSubmit(duel, 'p1', now).ok, true);

clock(duel.countdownEndsAt + TURN_MIN_MS);
check('a single-turn side stays on turn 0', turnIndexFor(duel, 'A', now), 0);
check('and so does the other one', turnIndexFor(duel, 'B', now), 0);
check('the one turn runs to the end of the window', playerTurnFor(duel, 'p2').endsAt, duel.drawEndsAt);
check('nothing may sync after the window closes', (() => {
  clock(duel.drawEndsAt);
  return checkSync(duel, 'p1', now).status;
})(), 400);

clock(duel.drawEndsAt);
check('drawing ends → voting', phaseOf(duel, now), 'voting');
check('p1 may vote', checkVote(duel, 'p1', now).ok, true);
check('a declined player may not vote', (() => {
  decline(duel, 'p2');
  const res = checkVote(duel, 'p2', now);
  accept(duel, 'p2');
  return res.status;
})(), 403);
duel.votes.p1 = 'A';
check('voting twice is refused', checkVote(duel, 'p1', now).status, 400);
duel.votes.p2 = 'A';
check('tally counts both', tallyVotes(duel), { A: 2, B: 0, winner: 'A' });

clock(duel.voteEndsAt);
check('voting ends → closed', phaseOf(duel, now), 'closed');
check('winner is tallied lazily on read', tallyVotes(duel).winner, 'A');
duel.winner = 'A';
duel.closedAt = now;
check('a settled battle stays closed', phaseOf(duel, now), 'closed');
check('nothing left to write', phasePatch(duel, now), null);

// ---------------------------------------------------------------------------
section('2. Group battle with unequal teams (3 vs 2)');
// ---------------------------------------------------------------------------

const group3v2 = makeDoc({ createdBy: 'a1', sides: { A: ['a1', 'a2', 'a3'], B: ['b1', 'b2'] } });
clock(T0);
for (const id of ['a2', 'a3', 'b1', 'b2']) accept(group3v2, id);
for (const id of ['a1', 'a2', 'a3', 'b1', 'b2']) readyUp(group3v2, id);
check('all ready → countdown', phaseOf(group3v2, now), 'countdown');
advance(group3v2);
check('longer team drives the slot length', group3v2.turnMs, Math.ceil(DRAW_WINDOW_MS / 3));
check('order is the accepted players per side', group3v2.order, { A: ['a1', 'a2', 'a3'], B: ['b1', 'b2'] });
check('drawing window is the full DRAW_WINDOW_MS', group3v2.drawEndsAt - group3v2.drawStartAt, DRAW_WINDOW_MS);
check('a two-player team splits the window in half', (() => {
  const even = makeDoc({ createdBy: 'a1', sides: { A: ['a1', 'a2'], B: ['b1', 'b2'] } });
  for (const id of ['a2', 'b1', 'b2']) accept(even, id);
  for (const id of Object.keys(even.participants)) readyUp(even, id);
  advance(even);
  return even.turnMs;
})(), DRAW_WINDOW_MS / 2);
check('a long team hits the turn floor instead', (() => {
  const big = makeDoc({ createdBy: 'a1', sides: { A: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'], B: ['b1'] } });
  for (const id of Object.keys(big.participants)) {
    if (id !== 'a1') accept(big, id);
  }
  for (const id of Object.keys(big.participants)) readyUp(big, id);
  advance(big);
  return big.turnMs;
})(), TURN_MIN_MS);

clock(group3v2.countdownEndsAt);
check('side A opens with a1', turnWindowFor(group3v2, 'A', now).userId, 'a1');
check('a1 may sync', checkSync(group3v2, 'a1', now).ok, true);
check('a teammate may not sync out of turn', checkSync(group3v2, 'a2', now).status, 403);
check('both sides draw in parallel', checkSync(group3v2, 'b1', now).ok, true);
check('a player waiting on the other side is refused', checkSync(group3v2, 'b2', now).status, 403);

clock(group3v2.drawStartAt + group3v2.turnMs);
check('a2 is up', turnWindowFor(group3v2, 'A', now).userId, 'a2');
check('a3 has not come up yet', checkSync(group3v2, 'a3', now).status, 403);
check('a1 is inside the grace period, so still allowed', checkSync(group3v2, 'a1', now).ok, true);
check('a2 may sync', checkSync(group3v2, 'a2', now).ok, true);
clock(group3v2.drawStartAt + group3v2.turnMs + TURN_GRACE_MS);
check('a1 is refused once the grace period is over', checkSync(group3v2, 'a1', now).status, 409);
clock(group3v2.drawStartAt + 2 * group3v2.turnMs);

clock(group3v2.drawStartAt + 2 * group3v2.turnMs);
check('a3 is up', turnWindowFor(group3v2, 'A', now).userId, 'a3');
check('the two-player side holds its last player', turnWindowFor(group3v2, 'B', now).userId, 'b2');
check('b1 is long past their grace period', checkSync(group3v2, 'b1', now).status, 409);
check('b2 may sync', checkSync(group3v2, 'b2', now).ok, true);

clock(group3v2.drawStartAt + 3 * group3v2.turnMs);
check('drawing window is over → voting', phaseOf(group3v2, now), 'voting');
check('nobody may sync once voting is open', checkSync(group3v2, 'a3', now).status, 400);

// ---------------------------------------------------------------------------
section('3. A late sync is kept for the grace period, then refused');
// ---------------------------------------------------------------------------

const grace = makeDoc({ createdBy: 'a1', sides: { A: ['a1', 'a2'], B: ['b1'] } });
clock(T0);
accept(grace, 'a2');
accept(grace, 'b1');
for (const id of Object.keys(grace.participants)) readyUp(grace, id);
advance(grace);
const slotEnd = grace.drawStartAt + grace.turnMs;
clock(slotEnd);
check('the slot has ended', phaseOf(grace, now), 'drawing');
check('the player who just finished is still inside the grace period', checkSync(grace, 'a1', now).ok, true);
check('the next teammate may already start', turnWindowFor(grace, 'A', now).userId, 'a2');
check('the new turn owner may sync', checkSync(grace, 'a2', now).ok, true);
clock(slotEnd + TURN_GRACE_MS);
const late = checkSync(grace, 'a1', now);
check('after the grace period the late write is refused', late.status, 409);
ok('the refusal explains itself', /turn is over/i.test(late.error || ''), late.error);
check('the new turn owner is unaffected', checkSync(grace, 'a2', now).ok, true);

// ---------------------------------------------------------------------------
section('4. Declining removes a player from the battle only');
// ---------------------------------------------------------------------------

const declined = makeDoc({ createdBy: 'a1', sides: { A: ['a1', 'a2'], B: ['b1', 'b2'] } });
clock(T0);
decline(declined, 'b1');
accept(declined, 'b2');
check('the battle continues with one player on side B', phaseOf(declined, now), 'inviting');
accept(declined, 'a2');
check('invitations are closed', phaseOf(declined, now), 'ready');
check('the decliner cannot sync', checkSync(declined, 'b1', now).status, 403);
check('the decliner cannot vote later either', (() => {
  for (const id of Object.keys(declined.participants)) readyUp(declined, id);
  advance(declined);
  clock(declined.drawStartAt);
  return checkVote(declined, 'b1', now).status;
})(), 403);
check('the remaining side B player is in the order', declined.order.B, ['b2']);
check('side A keeps its own order', declined.order.A, ['a1', 'a2']);

// ---------------------------------------------------------------------------
section('5. Nobody accepted on one side cancels the battle');
// ---------------------------------------------------------------------------

const empty = makeDoc({ createdBy: 'a1', sides: { A: ['a1'], B: ['b1'] } });
clock(T0);
check('inviting while the invite is open', phaseOf(empty, now), 'inviting');
clock(empty.invitesEndsAt);
check('an unanswered invite has expired → the battle is cancelled', phaseOf(empty, now), 'cancelled');
const cancelPatch = phasePatch(empty, now);
check('the cancel is persisted with a reason', cancelPatch.set, {
  cancelledAt: empty.invitesEndsAt,
  cancelReason: 'nobody_accepted',
});
advance(empty);
check('nothing else is written afterwards', phasePatch(empty, now), null);
check('a cancelled battle cannot be readied up', checkReady(empty, 'b1', now).status, 403);
check('a cancelled battle cannot be voted on', checkVote(empty, 'a1', now).status, 400);

// Partial answer: one of two opponents accepts, the other never replies.
const partial = makeDoc({ createdBy: 'a1', sides: { A: ['a1', 'a2'], B: ['b1', 'b2'] } });
clock(T0);
accept(partial, 'a2');
accept(partial, 'b1');
clock(partial.invitesEndsAt);
check('the battle survives one unanswered invite', phaseOf(partial, now), 'ready');
check('the un-answered player is not in the turn order', (() => {
  for (const id of Object.keys(partial.participants)) if (partial.participants[id].status === 'accepted') readyUp(partial, id);
  advance(partial);
  return partial.order.B;
})(), ['b1']);

// ---------------------------------------------------------------------------
section('6. Readiness cannot be blocked past readyEndsAt');
// ---------------------------------------------------------------------------

const lateReady = makeDoc({ createdBy: 'a1', sides: { A: ['a1', 'a2'], B: ['b1'] } });
clock(T0);
for (const id of ['a2', 'b1']) accept(lateReady, id);
check('waiting for the others → ready', phaseOf(lateReady, now), 'ready');
readyUp(lateReady, 'a1');
readyUp(lateReady, 'b1');
check('a2 never pressed ready', lateReady.participants.a2.readyAt, 0);
clock(readyEndsAtOf(lateReady, T0 + INVITE_WINDOW_MS) + 1);
check('the ready window runs out → countdown anyway', phaseOf(lateReady, now), 'countdown');
advance(lateReady);
check('the un-ready player is still in the order', lateReady.order.A, ['a1', 'a2']);
check('readying up during the countdown is still allowed', checkReady(lateReady, 'a2', now).ok, true);
check('a pending invitee cannot ready up', (() => {
  const waiting = makeDoc({ createdBy: 'a1', sides: { A: ['a1'], B: ['b1'] } });
  return checkReady(waiting, 'b1', T0).status;
})(), 403);

// ---------------------------------------------------------------------------
section('7. Cancelling before the drawing starts');
// ---------------------------------------------------------------------------

const cancellable = makeDoc({ createdBy: 'a1', sides: { A: ['a1'], B: ['b1'] } });
clock(T0);
check('the organiser may cancel', checkCancel(cancellable, 'a1').ok, true);
check('a player may not cancel', checkCancel(cancellable, 'b1').status, 403);
check('a stranger may not cancel', checkCancel(cancellable, 'outsider').status, 403);
cancellable.cancelledAt = now;
cancellable.cancelReason = 'creator_cancelled';
check('a cancelled battle reads as cancelled', phaseOf(cancellable, now), 'cancelled');
check('cancelling twice is refused', checkCancel(cancellable, 'a1').status, 400);
check('nothing is left to persist', phasePatch(cancellable, now), null);
check('a running battle cannot be cancelled by its organiser', (() => {
  const running = makeDoc({ createdBy: 'a1', sides: { A: ['a1'], B: ['b1'] } });
  for (const id of ['b1']) accept(running, id);
  for (const id of Object.keys(running.participants)) readyUp(running, id);
  advance(running);
  clock(running.countdownEndsAt);
  return checkCancel(running, 'a1').status;
})(), 400);

// ---------------------------------------------------------------------------
section('8. Payload caps');
// ---------------------------------------------------------------------------

const stroke = (n) => ({ pts: Array.from({ length: n }, () => [1, 2]), col: '#000', size: 4 });
check('a normal payload passes', validateSyncPayload([stroke(10), stroke(10)]), null);
check('a non-array is refused', validateSyncPayload('nope'), 'Malformed drawing data.');
check('too many strokes', validateSyncPayload([stroke(1), stroke(1)], undefined) === null, true);
ok('the stroke cap is enforced', validateSyncPayload(Array.from({ length: MAX_STROKES_PER_ENTRY + 1 }, () => stroke(1))), `A drawing holds at most ${MAX_STROKES_PER_ENTRY} strokes.`);
ok('the point cap is enforced', validateSyncPayload([stroke(MAX_POINTS_PER_STROKE + 1)]), `A single stroke holds at most ${MAX_POINTS_PER_STROKE} points.`);
ok('the body cap is enforced', validateSyncPayload([stroke(1)], MAX_SYNC_BODY_BYTES + 1) !== null, true);
ok('a body under the cap passes', validateSyncPayload([stroke(1)], MAX_SYNC_BODY_BYTES) === null, true);
ok('the fill cap is enforced', validateSyncPayload([{ pts: [], imgSrc: 'x'.repeat(MAX_IMGSRC_CHARS + 1) }]), 'That fill is too big to sync. Try filling a smaller area.');
check('a small fill passes', validateSyncPayload([{ pts: [], imgSrc: 'data:image/png;base64,AA' }]), null);
ok('a malformed stroke is refused', validateSyncPayload([{ pts: 'nope' }]), 'Malformed drawing data.');
ok('a bucket-fill stroke without pts is fine', validateSyncPayload([{ imgSrc: 'data:image/png;base64,AA', wx: 1, wy: 2, ww: 3, wh: 4 }]) === null, true);

// ---------------------------------------------------------------------------
section('9. Turn order puts the organiser first');
// ---------------------------------------------------------------------------

const rotated = makeDoc({ createdBy: 'a3', sides: { A: ['a1', 'a2', 'a3'], B: ['b1'] } });
clock(T0);
accept(rotated, 'a1');
accept(rotated, 'a2');
check('the organiser is rotated to the front', pickTurnOrder(rotated, 'A'), ['a3', 'a1', 'a2']);
check('unaccepted players are left out', pickTurnOrder(rotated, 'B'), []);
check('the caller turn window is derived, not stored', playerTurnFor(rotated, 'a3'), null);

// ---------------------------------------------------------------------------
section('10. Voting targets, ties and the pre-phase-machine documents');
// ---------------------------------------------------------------------------

check('a side letter resolves', sideFor(duel, 'A'), 'A');
check('a group id resolves to its side', sideFor(group3v2, 'group-b'), 'B');
check('a nonsense target does not', sideFor(group3v2, 'group-z'), null);
check('a duel has no group to resolve', sideFor(duel, 'group-b'), null);
check('a tie has no winner', tallyVotes({ votes: { p1: 'A', p2: 'B' } }), { A: 1, B: 1, winner: null });
check('no votes is a tie', tallyVotes({ votes: {} }), { A: 0, B: 0, winner: null });
check('legacy group-id votes still tally', tallyVotes({ groupA: 'g1', groupB: 'g2', votes: { p1: 'g1', p2: 'g2', p3: 'g2' } }), {
  A: 1,
  B: 2,
  winner: 'B',
});

const legacy = {
  _id: 'old',
  prompt: 'p',
  groupA: 'g1',
  groupB: 'g2',
  createdAt: T0 - 60 * MIN,
  drawEndTime: T0 - 30 * MIN,
  voteEndTime: T0 - 20 * MIN,
  entries: { g1: { strokes: [] }, g2: { strokes: [] } },
  votes: {},
  winner: null,
  closedAt: null,
  cancelledAt: null,
};
check('an old battle is recognised', isLegacyBattle(legacy), true);
check('an old battle reads as closed', phaseOf(legacy, T0), 'closed');
check('an old battle is never rewritten by the phase machine', phasePatch(legacy, T0), null);
check('a current battle is not legacy', isLegacyBattle(duel), false);

// ---------------------------------------------------------------------------
section('11. Resume from every phase (the same document, read again later)');
// ---------------------------------------------------------------------------

// One walk through a whole battle. The only things that ever happen are the
// players' own answers plus the phase-boundary writes; `step` is the polling
// cadence, which is the thing that must not change the outcome.
function walk({ step, answerAt, readyA, readyB, readyA2 }) {
  const doc = makeDoc({ createdBy: 'a1', sides: { A: ['a1', 'a2'], B: ['b1'] } });
  const samples = [];
  let answered = false;
  let scheduledAt = null;
  for (let t = T0; t < T0 + 90 * MIN; t += step) {
    clock(t);
    if (!answered && t >= answerAt) {
      accept(doc, 'a2');
      accept(doc, 'b1');
      answered = true;
    }
    const pressReady = (id, at) => {
      const p = doc.participants[id];
      if (at !== undefined && t >= at && p.status === 'accepted' && !p.readyAt) {
        doc.participants[id] = { ...p, readyAt: at };
      }
    };
    pressReady('a1', readyA);
    pressReady('b1', readyB);
    pressReady('a2', readyA2);
    advance(doc, t);
    const phase = phaseOf(doc, t);
    if (doc.countdownEndsAt && scheduledAt === null) scheduledAt = t;
    samples.push({ t, phase });
    if (phase === 'closed') break;
  }
  return { doc, samples, scheduledAt };
}

const ACTIONS = { answerAt: T0 + INVITE_WINDOW_MS, readyA: T0 + 5000, readyB: T0 + 20_000 };
const quick = walk({ step: 1000, ...ACTIONS });
const lazy = walk({ step: 7000, ...ACTIONS });
// a2 never pressed "I'm ready" in the two walks above, so the ready window had
// to run out on its own and the battle still started.
const lateComer = walk({
  step: 1000,
  answerAt: T0 + INVITE_WINDOW_MS,
  readyA: T0 + INVITE_WINDOW_MS + 30_000,
  readyB: T0 + INVITE_WINDOW_MS + 31_000,
  readyA2: T0 + INVITE_WINDOW_MS + 45_000,
});

const visited = (w) => w.samples.filter((s2, i) => i === 0 || s2.phase !== w.samples[i - 1].phase).map((s2) => s2.phase);
check('every phase is visited in order', visited(quick), ['inviting', 'ready', 'countdown', 'drawing', 'voting', 'closed']);
check('and again when polling is lazy', visited(lazy), visited(quick));
check('and again when everyone is ready inside the window', visited(lateComer), visited(quick));
ok('a late ready press starts the battle earlier', lateComer.doc.countdownEndsAt < quick.doc.countdownEndsAt);

const lazyAt = new Map(lazy.samples.map((s2) => [s2.t, s2.phase]));
const disagreements = quick.samples.filter((s2) => lazyAt.has(s2.t) && lazyAt.get(s2.t) !== s2.phase);
check('a 1s poll and a 7s poll always agree', disagreements.length, 0);
check('both cadences froze the same roster and slot length', {
  order: quick.doc.order,
  turn: quick.doc.turnMs,
  draw: quick.doc.drawEndsAt - quick.doc.drawStartAt,
}, {
  order: lazy.doc.order,
  turn: lazy.doc.turnMs,
  draw: lazy.doc.drawEndsAt - lazy.doc.drawStartAt,
});
ok(
  'whichever read hits the ready deadline first writes the schedule, and the other waits one step',
  lazy.doc.countdownEndsAt >= quick.doc.countdownEndsAt
    && lazy.doc.countdownEndsAt <= quick.doc.readyEndsAt + COUNTDOWN_MS + 7000
);

// A cold read: nothing but the document and the clock, no memory of the walk.
const settled = quick.doc;
check('a cold read a long time later is still closed', phaseOf(structuredClone(settled), T0 + 60 * MIN), 'closed');
check('and needs no further writes', phasePatch(settled, T0 + 60 * MIN), null);
check('a read at the vote deadline is closed', phaseOf(settled, settled.voteEndsAt), 'closed');
check('one millisecond earlier it is still voting', phaseOf(settled, settled.voteEndsAt - 1), 'voting');
check('a read at the end of drawing is voting', phaseOf(settled, settled.drawEndsAt), 'voting');
check('one millisecond earlier it is still drawing', phaseOf(settled, settled.drawEndsAt - 1), 'drawing');
check('a read at the end of the countdown is drawing', phaseOf(settled, settled.countdownEndsAt), 'drawing');
check('the countdown lasts exactly COUNTDOWN_MS from the read that froze it', quick.doc.drawStartAt - quick.scheduledAt, COUNTDOWN_MS);
check('and the same for a lazy poll', lazy.doc.drawStartAt - lazy.scheduledAt, COUNTDOWN_MS);
check('a fresh battle is inviting right up to its deadline', (() => {
  const fresh = makeDoc({ createdBy: 'a1', sides: { A: ['a1', 'a2'], B: ['b1'] } });
  return phaseOf(fresh, fresh.invitesEndsAt - 1);
})(), 'inviting');
check('every player who accepted is on the roster, ready or not', settled.order, { A: ['a1', 'a2'], B: ['b1'] });

// ---------------------------------------------------------------------------
section('12. Phase order is monotonic, whatever the clock does');
// ---------------------------------------------------------------------------

const ORDER = ['inviting', 'ready', 'countdown', 'drawing', 'voting', 'closed', 'cancelled'];
const monotonic = makeDoc({ createdBy: 'a1', sides: { A: ['a1', 'a2'], B: ['b1'] } });
clock(T0);
let last = -1;
let monotonicOk = true;
let writes = 0;
for (let i = 0; i < 900; i += 1) {
  const t = T0 + i * 10_000;
  clock(t);
  if (t >= monotonic.invitesEndsAt) {
    accept(monotonic, 'a2');
    accept(monotonic, 'b1');
  }
  for (const id of Object.keys(monotonic.participants)) {
    if (monotonic.participants[id].status === 'accepted' && !monotonic.participants[id].readyAt) {
      monotonic.participants[id] = { ...monotonic.participants[id], readyAt: t };
    }
  }
  if (phasePatch(monotonic, t)) writes += 1;
  advance(monotonic, t);
  const at = ORDER.indexOf(phaseOf(monotonic, t));
  if (at < last) monotonicOk = false;
  last = at;
}
ok('the phase never goes backwards over 2.5 simulated hours', monotonicOk);
check('and it finished closed', phaseOf(monotonic, now), 'closed');
check('the schedule was written exactly once', writes, 1);
check('and it is a real one', typeof monotonic.turnMs === 'number' && monotonic.turnMs > 0, true);

// ---------------------------------------------------------------------------
section('13. An artwork in progress belongs to the battle, not to whoever asks');
// ---------------------------------------------------------------------------
//
// `?strokes=1` is a traffic-budget question, never a permission one. While the
// drawing window is open the pixels are the players' own un-submitted work, so
// the view redacts them for anyone outside the battle — and inside it, from the
// other team, whose canvas is still being drawn. From voting onwards they are
// public: that is when people have to see the artwork to vote on it.

check('the drawing window is private', canSeeStrokes('drawing', null, 'A'), false);
check('a player sees their own side', canSeeStrokes('drawing', 'A', 'A'), true);
check('but not the other side, which is still being drawn', canSeeStrokes('drawing', 'A', 'B'), false);
check('voting shows the artwork to everyone', canSeeStrokes('voting', null, 'A'), true);
check('a finished battle stays public', canSeeStrokes('closed', null, 'A'), true);
check('before the first stroke there is nothing to hide', canSeeStrokes('countdown', null, 'A'), true);

const live = makeDoc({ createdBy: 'a1', sides: { A: ['a1', 'a2'], B: ['b1', 'b2'] } });
clock(T0);
decline(live, 'b2');
accept(live, 'a2');
accept(live, 'b1');
for (const id of ['a1', 'a2', 'b1']) readyUp(live, id);
advance(live);
clock(live.countdownEndsAt);
check('the battle is drawing', phaseOf(live, now), 'drawing');
live.entries.A.strokes = [stroke(1), stroke(1)];
live.entries.A.updatedAt = now;
live.entries.B.strokes = [stroke(1)];
live.entries.B.updatedAt = now;

const noRefs = { profiles: new Map(), groups: new Map() };
const pixels = (view) => view.entries.map((e) => e.strokes);
const sizes = (view) => view.entries.map((e) => e.strokes && e.strokes.length);

check('a stranger asking for pixels gets none', pixels(battleView(live, noRefs, 'nosy', now, true)), [null, null]);
check('and is told which side is theirs: none', battleView(live, noRefs, 'nosy', now, true).mySide, null);
check('the stroke counts stay public', battleView(live, noRefs, 'nosy', now, true).entries.map((e) => e.strokeCount), [2, 1]);
check('the organiser sees their own side in progress', sizes(battleView(live, noRefs, 'a1', now, true)), [2, null]);
check('a teammate on the same side does too', sizes(battleView(live, noRefs, 'a2', now, true)), [2, null]);
check('the other side sees only its own canvas', sizes(battleView(live, noRefs, 'b1', now, true)), [null, 1]);
check('a declined player is outside the battle', pixels(battleView(live, noRefs, 'b2', now, true)), [null, null]);
check('a metadata read is unchanged for a participant', pixels(battleView(live, noRefs, 'a1', now, false)), [null, null]);

clock(live.drawEndsAt);
check('the drawing window closes → voting', phaseOf(live, now), 'voting');
check('a stranger does see the artwork during voting', sizes(battleView(live, noRefs, 'nosy', now, true)), [2, 1]);
clock(live.voteEndsAt);
check('a finished battle is still public', sizes(battleView(live, noRefs, 'nosy', now, true)), [2, 1]);

// The pre-phase-machine documents had no roster at all, so membership is group
// membership — and a live one must be guarded the same way.
const oldLive = {
  _id: 'old-live',
  prompt: 'p',
  groupA: 'g1',
  groupB: 'g2',
  createdAt: T0 - MIN,
  drawEndTime: T0 + MIN,
  voteEndTime: T0 + 4 * MIN,
  entries: {
    g1: { strokes: [stroke(1)], updatedAt: T0, submittedAt: 0, rev: 0 },
    g2: { strokes: [stroke(1), stroke(1)], updatedAt: T0, submittedAt: 0, rev: 0 },
  },
  votes: {},
};
const oldRefs = { profiles: new Map(), groups: new Map([['g1', { _id: 'g1', name: 'G1', memberIds: ['a1'] }]]) };
clock(T0);
check('an old battle can still be drawing', phaseOf(oldLive, now), 'drawing');
check('the drawing group keeps seeing its own artwork', sizes(battleView(oldLive, oldRefs, 'a1', now, true)), [1, null]);
check('a stranger cannot watch a live old battle', pixels(battleView(oldLive, oldRefs, 'nosy', now, true)), [null, null]);
clock(oldLive.voteEndTime);
check('and it opens up with the vote', sizes(battleView(oldLive, oldRefs, 'nosy', now, true)), [1, 2]);

// ---------------------------------------------------------------------------
section('14. Cancelling only claims what it actually cancelled');
// ---------------------------------------------------------------------------
//
// The guard is the whole point: a document whose cancelledAt is null (older
// writes left it unset) must still be cancellable, and a write that matched
// nothing must never be reported as a cancellation.

const cancelReady = () => {
  const doc = makeDoc({ createdBy: 'a1', sides: { A: ['a1'], B: ['b1'] } });
  clock(T0);
  accept(doc, 'b1');
  advance(doc, T0); // writes readyEndsAt only: still cancellable, nothing due
  return doc;
};

const stored = cancelReady();
stored.cancelledAt = null; // written before the field existed
const competitions = fakeCollection([stored]);
const deps = { competitions };

const cancelled = await cancelBattle('a1', { doc: stored, now: T0 + 2000 }, deps);
check('a battle with no cancelledAt field is cancellable', cancelled, { ok: true, cancelledAt: T0 + 2000 });
check('and the document really says so', stored.cancelledAt, T0 + 2000);
check('the reason is written with it', stored.cancelReason, 'creator_cancelled');
ok(
  'a second, stale cancel is refused instead of reported as a cancellation',
  await cancelBattle('a1', { doc: cancelReady(), now: T0 + 3000 }, deps).then(
    () => false,
    (error) => error instanceof BattleError && error.status === 409
  )
);
check('and the stored cancellation was not overwritten', stored.cancelledAt, T0 + 2000);

const fresh = cancelReady();
const freshDeps = { competitions: fakeCollection([fresh]) };
check('a live battle cancels normally', await cancelBattle('a1', { doc: fresh, now: T0 + 4000 }, freshDeps), {
  ok: true,
  cancelledAt: T0 + 4000,
});
check('and that one is written too', fresh.cancelledAt, T0 + 4000);

// ---------------------------------------------------------------------------
section('15. The feed reads only the caller\'s battles, and no pixels');
// ---------------------------------------------------------------------------

const running = cancelReady();
running._id = 'battle-running';
running.prompt = 'live one';
running.entries.A = { strokes: [stroke(1), stroke(1)], updatedAt: T0, submittedAt: T0 + 500, rev: 2 };

const finished = structuredClone(running);
finished._id = 'battle-finished';
finished.prompt = 'finished one';
finished.participants.b1.status = 'accepted';
finished.participants.a1.readyAt = T0 + 1000;
finished.participants.b1.readyAt = T0 + 1000;
finished.readyEndsAt = T0 + 2000;
finished.order = { A: ['a1'], B: ['b1'] };
finished.turnMs = DRAW_WINDOW_MS;
finished.countdownEndsAt = T0 + COUNTDOWN_MS;
finished.drawStartAt = finished.countdownEndsAt;
finished.drawEndsAt = finished.drawStartAt + finished.turnMs;
finished.voteEndsAt = finished.drawEndsAt + VOTE_WINDOW_MS;
finished.votes = { a1: 'A', b1: 'B' };
finished.createdAt = T0 - 10 * MIN;

const stranger = structuredClone(finished);
stranger._id = 'battle-stranger';
stranger.prompt = 'somebody else\'s battle';
stranger.groupA = 'group-x';
stranger.groupB = 'group-y';
stranger.participants = { x1: { ...stranger.participants.a1 }, x2: { ...stranger.participants.b1 } };
stranger.votes = { x1: 'A', x2: 'A' };
stranger.createdAt = T0 + MIN; // the newest document in the collection

const feedRows = fakeCollection([stranger, finished, running]);
const feedGroups = fakeCollection([
  { _id: 'group-a', name: 'A', memberIds: ['a1'] },
  { _id: 'group-b', name: 'B', memberIds: ['b1'] },
]);
const feedProfiles = fakeCollection([{ _id: 'a1', nickname: 'Ann' }]);
const feedDeps = { competitions: feedRows, groups: feedGroups, profiles: feedProfiles };
const feed = await listBattles('a1', { now: finished.voteEndsAt }, feedDeps);
const feedComp = feedRows.log.finds[0].filter;
const feedClauses = feedComp.$or || [];

check('a stranger\'s battle is not in the feed', feed.active.concat(feed.recent).map((s) => s.id).includes('battle-stranger'), false);
check('the caller\'s live battle is', feed.active.map((s) => s.id), ['battle-running']);
check('and so is their finished one', feed.recent.map((s) => s.id), ['battle-finished']);
ok('the battle query is scoped, not the whole collection', Object.keys(feedComp).length > 0);
check('by the caller\'s own participation', Object.keys(feedClauses[0] || {}), ['participants.a1']);
check('and by the groups they are in', [feedClauses[1]?.groupA?.$in, feedClauses[2]?.groupB?.$in].map((v) => v?.includes('group-a')), [true, true]);
ok('the query is still sorted and capped', feedRows.log.sorts[0]?.createdAt === -1 && feedRows.log.limits[0] > 0);
// `order` is a handful of user ids per side; projecting it away made every turn
// in the feed silently null while the list still asked for one.
ok('the read keeps the turn order, so the feed can name a turn', !feedRows.log.projections.some((p) => p?.order === 0));
check('and the feed reports the very turn the document supports', feed.active[0].turn, playerTurnFor(running, 'a1'));
ok('and the artwork out of both entry slots', feedRows.log.projections.some((p) => p?.['entries.A.strokes'] === 0 && p?.['entries.B.strokes'] === 0));
check('the list carries no stroke data at all', JSON.stringify(feed).includes('pts'), false);
check('but the entry metadata survives', feed.active[0].submitted, true);
check('a tie is reported as no winner', feed.recent[0].winner, null);

check('listing settled the finished battle', { winner: finished.winner, closedAt: finished.closedAt }, { winner: null, closedAt: finished.voteEndsAt });
check('and the group record agrees', feedGroups.docs.map((g) => ({ played: g.played || 0, wins: g.wins || 0 })), [
  { played: 1, wins: 0 },
  { played: 1, wins: 0 },
]);
check('a live battle is not settled', running.closedAt, 0);
await listBattles('a1', { now: finished.voteEndsAt }, feedDeps);
check('listing it again does not count it twice', feedGroups.docs.map((g) => g.played), [1, 1]);

// ---------------------------------------------------------------------------
section('16. The invite call and the invite payload are what they claim to be');
// ---------------------------------------------------------------------------
//
// api/groups.js is an HTTP handler with no injection seam, so the two ways it
// can strand a group — a call that does not match its declaration, and a Map
// handed to JSON.stringify — are pinned against the source itself.

const groupsSource = readSource('api/groups.js');
const arity = (src) =>
  [...src.matchAll(/(function )?sendInvite\(([^;\n]*?)\)/g)].map(([, isDecl, args]) => ({ decl: Boolean(isDecl), n: args.split(',').length }));
check('sendInvite is declared with three parameters', arity(groupsSource).filter((s) => s.decl).map((s) => s.n), [3]);
check('and every call site passes three arguments', arity(groupsSource).filter((s) => !s.decl).map((s) => s.n), [3, 3]);

// pendingInvites answers with a Map, and a Map reaches JSON.stringify as `{}` —
// which is not the array of invites the client maps over.
ok('pendingInvites is a Map, so the payloads have to unwrap it', /const out = new Map\(\)/.test(groupsSource) && /return out;/.test(groupsSource));
const invitedProps = [...groupsSource.matchAll(/^\s*invited([,:][^\n]*)$/gm)].map(([, tail]) => tail.trim());
ok('no payload hands a Map straight to JSON.stringify', invitedProps.every((v) => v !== ','));
check('every invited payload is an array', invitedProps.every((v) => /(\|\|\s*\[\]|\[\s*\])\s*,?$/.test(v)), true);
check('and there is one per group payload', invitedProps.length, 2);

console.log(`\n${'-'.repeat(64)}`);
if (failures.length) {
  console.log(`FAILED — ${passed} passed, ${failures.length} failed\n`);
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log(`PASSED — ${passed} checks green`);
process.exit(0);
