// Server-side mirror of src/lib/battle.ts — keep the constants in both copies in
// sync. Every battle decision (which phase a battle is in, whose turn it is, who
// is allowed to sync, who won) is a PURE function of the stored document plus an
// explicit `now`. There is no I/O here, no database, no timer and no module
// state — that is what makes a refresh, a reconnect, a cold start or an hour-old
// tab resume exactly where the document says, and it is what
// scripts/battle-lifecycle.mjs drives with a fake clock.

export const DRAW_WINDOW_MS = 5 * 60 * 1000;
export const VOTE_WINDOW_MS = 3 * 60 * 1000;

// How long an unanswered invitation stays open, and how long accepted players
// have to press "I'm ready" before the battle starts anyway.
export const INVITE_WINDOW_MS = 10 * 60 * 1000;
export const READY_WINDOW_MS = 2 * 60 * 1000;
export const COUNTDOWN_MS = 3 * 1000;

// Turn length inside the drawing window. A team too big to fill the 5-minute
// window gets shorter turns, never shorter than this.
export const TURN_MIN_MS = 45 * 1000;
// A turn owner may keep syncing for this long after their slot ended, so a
// request that was in flight when the clock flipped is not thrown away.
export const TURN_GRACE_MS = 5 * 1000;

// Hard payload caps. Every one of these is refused with a 4xx and a message, so
// a single document can never approach Mongo's 16 MB or Vercel's 4.5 MB function
// body limit — the size the old whole-array sync and whole-array poll blew.
export const MAX_STROKES_PER_ENTRY = 400;
export const MAX_POINTS_PER_STROKE = 2000;
export const MAX_SYNC_BODY_BYTES = 512 * 1024;
export const MAX_IMGSRC_CHARS = 220 * 1024;
export const MAX_PROMPT_CHARS = 120;
export const MAX_TITLE_CHARS = 40;

export const CANCEL_REASON = {
  NOBODY_ACCEPTED: 'nobody_accepted',
  CREATOR: 'creator_cancelled',
  GROUP_GONE: 'group_deleted',
  ADMIN: 'admin_deleted',
};

export const BATTLE_PROMPTS = [
  'Draw a dragon made of clouds',
  'Draw a carnival in space',
  'Draw a friendly alien café',
  'Draw a city inside a bubble',
  "Draw a robot's best friend",
  'Draw a flying pizza delivery',
  'Draw an underwater sky',
  'Draw a house built from books',
  'Draw a superpowered snack',
  "Draw the rainbow's source",
  'Draw a time-traveling bus',
  'Draw a garden of talking plants',
  'Draw a castle on a comet',
  'Draw a giant friendly whale in the sky',
  'Draw a portal to your dream world',
];

// ---------------------------------------------------------------------------
// Participants
// ---------------------------------------------------------------------------

// Battles written before the phase machine have no participants map at all and
// carry the old drawEndTime/voteEndTime schedule. They are read-only history
// now, but they must keep rendering, so their phase is derived the old way.
export function isLegacyBattle(doc) {
  return Boolean(doc) && !doc.participants && typeof doc.drawEndTime === 'number';
}

export function participantOf(doc, userId) {
  if (!doc?.participants || !userId) return null;
  return doc.participants[userId] || null;
}

export function pendingCount(doc) {
  if (!doc?.participants) return 0;
  let n = 0;
  for (const p of Object.values(doc.participants)) {
    if (p?.status === 'pending') n += 1;
  }
  return n;
}

// A pending invitation whose deadline has passed IS a decline — derived from the
// timestamps, never written back to the document.
export function pendingExpired(doc, now) {
  return pendingCount(doc) > 0 && now >= (doc?.invitesEndsAt || 0);
}

export function isInviting(doc, now) {
  return pendingCount(doc) > 0 && now < (doc?.invitesEndsAt || 0);
}

// Accepted player ids per side, in the order they joined the document.
export function acceptedSides(doc) {
  const out = { A: [], B: [] };
  if (!doc?.participants) return out;
  for (const [userId, p] of Object.entries(doc.participants)) {
    if (p?.status === 'accepted' && (p.side === 'A' || p.side === 'B')) out[p.side].push(userId);
  }
  return out;
}

export function acceptedCounts(doc) {
  const sides = acceptedSides(doc);
  return { A: sides.A.length, B: sides.B.length };
}

export function allAcceptedReady(doc) {
  const sides = acceptedSides(doc);
  const accepted = [...sides.A, ...sides.B];
  if (!accepted.length) return false;
  return accepted.every((id) => Boolean(doc.participants[id]?.readyAt));
}

// Turn order: accepted players of a side, rotated so the creator draws first.
export function pickTurnOrder(doc, side) {
  const list = acceptedSides(doc)[side] || [];
  const at = list.indexOf(doc?.createdBy);
  if (at <= 0) return list;
  return [...list.slice(at), ...list.slice(0, at)];
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

// The whole drawing/voting schedule, derived once when the countdown starts and
// then stored on the document for everyone to read.
export function turnSchedule(doc, now) {
  const order = { A: pickTurnOrder(doc, 'A'), B: pickTurnOrder(doc, 'B') };
  const maxTurns = Math.max(order.A.length, order.B.length, 1);
  const turnMs = Math.max(TURN_MIN_MS, Math.ceil(DRAW_WINDOW_MS / maxTurns));
  const countdownEndsAt = now + COUNTDOWN_MS;
  const drawStartAt = countdownEndsAt;
  const drawEndsAt = drawStartAt + turnMs * maxTurns;
  return {
    order,
    turnMs,
    maxTurns,
    countdownEndsAt,
    drawStartAt,
    drawEndsAt,
    voteEndsAt: drawEndsAt + VOTE_WINDOW_MS,
  };
}

export function turnIndexFor(doc, side, now) {
  const list = doc?.order?.[side] || [];
  if (!list.length) return -1;
  const turnMs = doc.turnMs || TURN_MIN_MS;
  const start = doc.drawStartAt || 0;
  if (now < start) return 0;
  return Math.min(list.length - 1, Math.max(0, Math.floor((now - start) / turnMs)));
}

// Whose turn it is on `side`, and the absolute window it runs in. Both teams run
// in parallel from the same drawStartAt, so a team with fewer players simply
// holds on its last player for the remaining slots.
export function turnWindowFor(doc, side, now) {
  const list = doc?.order?.[side] || [];
  if (!list.length) return null;
  const turnMs = doc.turnMs || TURN_MIN_MS;
  const start = doc.drawStartAt || 0;
  const index = turnIndexFor(doc, side, now);
  return {
    index,
    total: list.length,
    userId: list[index],
    startsAt: start + index * turnMs,
    endsAt: start + (index + 1) * turnMs,
    graceEndsAt: start + (index + 1) * turnMs + TURN_GRACE_MS,
  };
}

// The caller's own slot, whether it is still to come, live, over, or inside the
// grace period. The last player of a side keeps the slot open until the drawing
// window closes, which is exactly where turnIndexFor stops clamping.
export function playerTurnFor(doc, userId) {
  const p = participantOf(doc, userId);
  if (!p) return null;
  const list = doc?.order?.[p.side] || [];
  const index = list.indexOf(userId);
  if (index < 0) return null;
  const turnMs = doc.turnMs || TURN_MIN_MS;
  const start = doc.drawStartAt || 0;
  const startsAt = start + index * turnMs;
  const endsAt = index === list.length - 1 ? Math.max(startsAt + turnMs, doc.drawEndsAt || 0) : startsAt + turnMs;
  return {
    side: p.side,
    index,
    total: list.length,
    startsAt,
    endsAt,
    graceEndsAt: endsAt + TURN_GRACE_MS,
  };
}

// The ready deadline, whether or not it has been written to the document yet:
// everyone answered early gives a fresh window, otherwise it starts when the
// invitation window closes.
export function readyEndsAtOf(doc, now) {
  if (doc?.readyEndsAt) return doc.readyEndsAt;
  const invitesEndsAt = doc?.invitesEndsAt || 0;
  return now < invitesEndsAt ? now + READY_WINDOW_MS : invitesEndsAt + READY_WINDOW_MS;
}

// ---------------------------------------------------------------------------
// Phase
// ---------------------------------------------------------------------------

export const PHASES = ['inviting', 'ready', 'countdown', 'drawing', 'voting', 'closed', 'cancelled'];

export function phaseOf(doc, now) {
  if (!doc) return 'cancelled';
  if (doc.cancelledAt) return 'cancelled';
  if (isLegacyBattle(doc)) return legacyPhaseOf(doc, now);
  if (isInviting(doc, now)) return 'inviting';

  // Invitations are closed: a side nobody joined cannot draw.
  const counts = acceptedCounts(doc);
  if (!counts.A || !counts.B) return 'cancelled';

  if (!doc.countdownEndsAt) {
    const startAnyway = allAcceptedReady(doc) || now >= readyEndsAtOf(doc, now);
    return startAnyway ? 'countdown' : 'ready';
  }
  if (now < doc.countdownEndsAt) return 'countdown';
  if (now < doc.drawEndsAt) return 'drawing';
  if (now < doc.voteEndsAt) return 'voting';
  return 'closed';
}

function legacyPhaseOf(doc, now) {
  if (now < (doc.drawEndTime || 0)) return 'drawing';
  if (now < (doc.voteEndTime || 0)) return 'voting';
  return 'closed';
}

export function isFinalPhase(phase) {
  return phase === 'closed' || phase === 'cancelled';
}

// The only writes this system ever makes: the phase boundary the document has
// already reached, as a guarded `$set` for the caller to apply. Returns null when
// nothing is due yet.
export function phasePatch(doc, now) {
  if (!doc || doc.cancelledAt || isLegacyBattle(doc)) return null;
  if (isInviting(doc, now)) return null;
  if (acceptedCounts(doc).A === 0 || acceptedCounts(doc).B === 0) {
    return {
      set: { cancelledAt: now, cancelReason: CANCEL_REASON.NOBODY_ACCEPTED },
      guard: { cancelledAt: { $in: [0, null] } },
    };
  }

  if (!doc.readyEndsAt) {
    const readyEndsAt = readyEndsAtOf(doc, now);
    if (!allAcceptedReady(doc) && now < readyEndsAt) {
      return { set: { readyEndsAt }, guard: { readyEndsAt: { $in: [0, null] } } };
    }
    const schedule = turnSchedule(doc, now);
    return {
      set: { readyEndsAt, ...schedule },
      guard: { readyEndsAt: { $in: [0, null] }, countdownEndsAt: { $in: [0, null] } },
    };
  }

  // Either the last accepted player pressed ready, or the ready window ran out
  // with someone still holding out: the countdown starts either way.
  if (!doc.countdownEndsAt && (allAcceptedReady(doc) || now >= doc.readyEndsAt)) {
    const schedule = turnSchedule(doc, now);
    return {
      set: schedule,
      guard: { countdownEndsAt: { $in: [0, null] } },
    };
  }

  return null;
}

// Which documents a list read is allowed to settle (finished, not cancelled,
// already tallied).
export function settleFilter(now) {
  return {
    closedAt: { $in: [0, null] },
    cancelledAt: { $in: [0, null] },
    voteEndsAt: { $gt: 0, $lte: now },
  };
}

// ---------------------------------------------------------------------------
// Votes
// ---------------------------------------------------------------------------

// Plurality, tie included. Duelling documents stored the group id as the vote
// value instead of the side letter; both are counted.
export function tallyVotes(doc) {
  const votes = doc?.votes || {};
  let a = 0;
  let b = 0;
  for (const value of Object.values(votes)) {
    if (value === 'A' || String(value) === String(doc?.groupA)) a += 1;
    else if (value === 'B' || String(value) === String(doc?.groupB)) b += 1;
  }
  return { A: a, B: b, winner: a === b ? null : a > b ? 'A' : 'B' };
}

// Resolves whatever the client called the thing it is voting for — a side
// letter, or (from the pre-phase-machine client) a group id — to a side.
export function sideFor(doc, value) {
  if (value === 'A' || value === 'B') return value;
  if (doc?.groupA && String(value) === String(doc.groupA)) return 'A';
  if (doc?.groupB && String(value) === String(doc.groupB)) return 'B';
  return null;
}

// ---------------------------------------------------------------------------
// Payload caps
// ---------------------------------------------------------------------------

// Returns an error message, or null when the strokes are acceptable. Never
// throws and never silently drops anything.
export function validateSyncPayload(strokes, byteLength) {
  if (!Array.isArray(strokes)) return 'Malformed drawing data.';
  if (typeof byteLength === 'number' && byteLength > MAX_SYNC_BODY_BYTES) {
    return 'That drawing is too big to sync. Reload the battle and keep drawing.';
  }
  if (strokes.length > MAX_STROKES_PER_ENTRY) {
    return `A drawing holds at most ${MAX_STROKES_PER_ENTRY} strokes.`;
  }
  for (const s of strokes) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return 'Malformed drawing data.';
    if (s.pts !== undefined && (!Array.isArray(s.pts) || (s.pts.length > 0 && !Array.isArray(s.pts[0])))) {
      return 'Malformed drawing data.';
    }
    if (Array.isArray(s.pts) && s.pts.length > MAX_POINTS_PER_STROKE) {
      return `A single stroke holds at most ${MAX_POINTS_PER_STROKE} points.`;
    }
    if (typeof s.imgSrc === 'string' && s.imgSrc.length > MAX_IMGSRC_CHARS) {
      return 'That fill is too big to sync. Try filling a smaller area.';
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Authorisation
// ---------------------------------------------------------------------------
//
// Each check is a pure decision the store applies verbatim, so the whole
// permission matrix is covered by the lifecycle test without a database.

const ALLOWED = (extra) => ({ ok: true, ...extra });
const DENIED = (status, error) => ({ ok: false, status, error });

function participantGuard(doc, userId) {
  const p = participantOf(doc, userId);
  if (!p) return DENIED(403, 'You are not part of this battle.');
  if (p.status !== 'accepted') return DENIED(403, 'You are not part of this battle.');
  return null;
}

export function checkRespond(doc, userId, now) {
  const p = participantOf(doc, userId);
  if (!p) return DENIED(403, 'You are not part of this battle.');
  if (doc.cancelledAt) return DENIED(400, 'This battle was cancelled.');
  if (p.status === 'accepted') return ALLOWED({ side: p.side, already: true });
  if (p.status === 'declined') return DENIED(400, 'You already declined this battle.');
  if (!isInviting(doc, now)) return DENIED(400, 'This invitation has expired.');
  return ALLOWED({ side: p.side });
}

export function checkReady(doc, userId, now) {
  const guard = participantGuard(doc, userId);
  if (guard) return guard;
  if (doc.cancelledAt) return DENIED(400, 'This battle was cancelled.');
  if (isInviting(doc, now)) return DENIED(400, 'Answer the invitation first.');
  return ALLOWED({ side: participantOf(doc, userId).side });
}

// Only the player whose turn it is may write, and only until their slot (plus a
// short grace period so a request in flight when the clock flipped is not lost)
// is over.
export function checkSync(doc, userId, now) {
  const guard = participantGuard(doc, userId);
  if (guard) return guard;
  if (phaseOf(doc, now) !== 'drawing') return DENIED(400, 'The drawing window is over.');
  const turn = playerTurnFor(doc, userId);
  if (!turn) return DENIED(400, 'Your team has no drawing slot.');
  if (now >= turn.graceEndsAt) return DENIED(409, 'Your turn is over — those strokes were not saved.');
  if (now < turn.startsAt) return DENIED(403, 'It is not your turn yet.');
  return ALLOWED({ side: turn.side, turn });
}

export function checkSubmit(doc, userId, now) {
  const guard = participantGuard(doc, userId);
  if (guard) return guard;
  if (phaseOf(doc, now) !== 'drawing') return DENIED(400, 'The drawing window is over.');
  return ALLOWED({ side: participantOf(doc, userId).side });
}

export function checkVote(doc, userId, now) {
  const guard = participantGuard(doc, userId);
  if (guard) return guard;
  if (phaseOf(doc, now) !== 'voting') return DENIED(400, 'Voting is not open yet.');
  if (doc.votes?.[userId]) return DENIED(400, 'You already voted.');
  return ALLOWED({ side: participantOf(doc, userId).side });
}

// Asking for pixel data is a traffic-budget question, never a permission one:
// while the drawing window is open the artwork is the players' own work in
// progress, so only the battle's own participants may read it — anyone else
// watching an opponent draw is watching a spoiler. Once the window closes the
// artwork is public, because that is when people have to see it in order to
// vote on it. The pixels are redacted from the view, not refused: everything
// else about the battle (participants, timings, stroke counts) stays public.
export function canSeeStrokes(phase, side) {
  return phase !== 'drawing' || Boolean(side);
}

export function checkCancel(doc, userId) {
  if (!participantOf(doc, userId)) return DENIED(403, 'You are not part of this battle.');
  if (String(doc.createdBy) !== String(userId)) return DENIED(403, 'Only the organiser can cancel this battle.');
  if (doc.cancelledAt) return DENIED(400, 'This battle was already cancelled.');
  if (doc.countdownEndsAt) return DENIED(400, 'This battle has already started.');
  return ALLOWED({});
}
