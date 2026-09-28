// Shared constants for battles (mirrored server-side in api-lib/battle.js —
// keep both copies in sync). The server owns the schedule: it returns the
// current phase and every deadline with the battle, so the client only counts
// down to what it was told and never decides a phase itself.

import type { Stroke } from './engine';

export const DRAW_WINDOW_MS = 5 * 60 * 1000;
export const VOTE_WINDOW_MS = 3 * 60 * 1000;
export const INVITE_WINDOW_MS = 10 * 60 * 1000;
export const READY_WINDOW_MS = 2 * 60 * 1000;
export const COUNTDOWN_MS = 3 * 1000;
export const TURN_MIN_MS = 45 * 1000;
export const TURN_GRACE_MS = 5 * 1000;

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

// Emoji avatars users + groups can pick.
export const AVATARS = ['🦊', '🐼', '🦄', '🐸', '🐙', '🐯', '🐨', '🐝', '🦋', '🚀', '🎨', '🌟', '🌈', '🍉', '⚡', '😎'];

// Why a battle stopped early. Mirrors CANCEL_REASON in api-lib/battle.js.
export const CANCEL_REASON = {
  NOBODY_ACCEPTED: 'nobody_accepted',
  CREATOR: 'creator_cancelled',
  GROUP_GONE: 'group_deleted',
  ADMIN: 'admin_deleted',
} as const;

export const CANCEL_REASON_TEXT: Record<string, string> = {
  [CANCEL_REASON.NOBODY_ACCEPTED]: 'Nobody accepted, so this battle could not start.',
  [CANCEL_REASON.CREATOR]: 'The organiser cancelled this battle.',
  [CANCEL_REASON.GROUP_GONE]: 'A group in this battle was deleted.',
  [CANCEL_REASON.ADMIN]: 'An admin ended this battle.',
};

export type BattlePhase =
  | 'inviting'
  | 'ready'
  | 'countdown'
  | 'drawing'
  | 'voting'
  | 'closed'
  | 'cancelled';

export type BattleSide = 'A' | 'B';

export interface BattleTurn {
  index: number;
  total: number;
  userId: string;
  startsAt: number;
  endsAt: number;
  graceEndsAt: number;
}

// `closed` and `cancelled` are final: the client stops polling and stops
// syncing there.
export function isFinalPhase(phase: BattlePhase): boolean {
  return phase === 'closed' || phase === 'cancelled';
}

// Poll cadence for a battle detail view: fast while people are drawing, calm
// everywhere else.
export function pollIntervalFor(phase: BattlePhase): number | 0 {
  if (isFinalPhase(phase)) return 0;
  return phase === 'drawing' ? 5000 : 10000;
}

// ---------------------------------------------------------------------------
// The view the server sends. `GET /api/competitions/:id` returns the metadata
// only; `?strokes=1` is what fills in `entries[].strokes`. The client never
// assumes a phase, a turn or a winner — it renders what it was told.
// ---------------------------------------------------------------------------

export type BattleKind = 'group' | 'duel';
export type BattleParticipantStatus = 'pending' | 'accepted' | 'declined';

export interface BattleSideInfo {
  id: string | null;
  userId?: string | null;
  name: string;
  emoji: string;
  kind: 'group' | 'player';
}

export interface BattleParticipant {
  userId: string;
  side: BattleSide;
  status: BattleParticipantStatus;
  ready: boolean;
  turnEnded: boolean;
  submitted: boolean;
  nickname: string;
  avatar: string;
  you: boolean;
}

export interface BattleEntry {
  side: BattleSide;
  groupId: string | null;
  strokeCount: number;
  updatedAt: number;
  submittedAt: number;
  rev: number;
  strokes: Stroke[] | null;
}

interface BattleCore {
  id: string;
  kind: BattleKind;
  prompt: string;
  createdAt: number;
  status: BattlePhase;
  groupA: BattleSideInfo;
  groupB: BattleSideInfo;
  mySide: BattleSide | null;
  myGroup: string | null;
  myStatus: BattleParticipantStatus | null;
  invitesEndsAt: number;
  drawEndsAt: number;
  voteEndsAt: number;
  submitted: boolean;
  hasVoted: boolean;
  votes: { A: number; B: number } | null;
  // A side letter, not a side object: the client resolves it against groupA/B.
  winner: BattleSide | null;
  cancelReason: string;
}

export interface BattleSummary extends BattleCore {
  turn: BattleTurn | null;
}

export interface BattleDetail extends BattleCore {
  phase: BattlePhase;
  rev: number;
  createdBy: string | null;
  readyEndsAt: number;
  countdownEndsAt: number;
  drawStartAt: number;
  turnMs: number;
  turn: { A: BattleTurn | null; B: BattleTurn | null };
  myReady: boolean;
  myTurn: (BattleTurn & { side: BattleSide }) | null;
  myVote: BattleSide | null;
  participants: BattleParticipant[];
  accepted: { A: number; B: number };
  entries: BattleEntry[];
}

export function sideInfoOf(battle: BattleCore, side: BattleSide) {
  return side === 'A' ? battle.groupA : battle.groupB;
}

export function entryOf(entries: BattleEntry[], side: BattleSide) {
  return entries.find((e) => e.side === side) || null;
}

// When the phase the battle is in runs out. 0 means the phase has no deadline
// of its own (already final, or a transition the server performs on the next
// read).
export function deadlineFor(battle: {
  status: BattlePhase;
  invitesEndsAt: number;
  drawEndsAt: number;
  voteEndsAt: number;
  readyEndsAt?: number;
  drawStartAt?: number;
}): number {
  switch (battle.status) {
    case 'inviting': return battle.invitesEndsAt;
    case 'ready': return battle.readyEndsAt;
    case 'countdown': return battle.drawStartAt;
    case 'drawing': return battle.drawEndsAt;
    case 'voting': return battle.voteEndsAt;
    default: return 0;
  }
}

// A turn is live from the instant it starts until its grace period ends, so a
// request that was already in flight when the clock flipped is not thrown away.
export function isTurnLive(turn: BattleTurn | null | undefined, now: number): boolean {
  return Boolean(turn && now >= turn.startsAt && now < turn.graceEndsAt);
}

// Pixel data is only ever fetched when the screen is about to show it: the
// shared team canvas while it is not your turn, the two entries while voting,
// and the result. Never during the invitation, readiness or countdown phases.
export function phaseNeedsPixels(phase: BattlePhase, myTurnLive: boolean): boolean {
  if (phase === 'voting' || phase === 'closed') return true;
  return phase === 'drawing' && !myTurnLive;
}
