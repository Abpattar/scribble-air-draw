import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  X, Swords, Timer, Trophy, Vote, Check, RefreshCw, AlertCircle, ChevronRight,
  Users, Sparkles, UserPlus, Hourglass, Flag, Crown, Play,
} from 'lucide-react';
import { useApi } from '../hooks/useApi';
import type { Stroke } from '../lib/engine';
import { renderStrokesToCanvas } from '../lib/strokeRenderer';
import {
  BATTLE_PROMPTS,
  CANCEL_REASON_TEXT,
  COUNTDOWN_MS,
  READY_WINDOW_MS,
  deadlineFor,
  entryOf,
  isTurnLive,
  phaseNeedsPixels,
  pollIntervalFor,
  sideInfoOf,
  type BattleDetail,
  type BattleEntry,
  type BattleParticipant,
  type BattlePhase,
  type BattleSide,
  type BattleSummary,
} from '../lib/battle';

interface Group {
  id: string;
  name: string;
  emoji: string;
  wins: number;
  played: number;
  adminId: string;
  members: { userId: string; nickname: string }[];
}
interface Friend {
  userId: string;
  nickname: string;
  email: string;
  avatar: string;
}

interface Props {
  onClose: () => void;
  sourceGroup?: Group | null;
  getStrokes: () => Stroke[];
  setStrokes: (strokes: Stroke[]) => void;
  canBattle?: boolean;
  onChange?: () => void;
}

// Only the current turn owner pushes strokes, and only the ones drawn since the
// last push, so the payload is proportional to new work, never to total work.
const SYNC_EVERY_MS = 5000;

const PHASE_META: Record<BattlePhase, { label: string; color: string; bg: string }> = {
  inviting: { label: 'Inviting', color: 'var(--kid-blue)', bg: 'rgba(47,155,255,0.12)' },
  ready: { label: 'Get ready', color: 'var(--kid-yellow)', bg: 'rgba(255,197,61,0.18)' },
  countdown: { label: 'Starting…', color: 'var(--accent2)', bg: 'rgba(124,92,246,0.15)' },
  drawing: { label: 'Drawing', color: 'var(--accent)', bg: 'rgba(47,155,255,0.12)' },
  voting: { label: 'Voting', color: 'var(--accent2)', bg: 'rgba(255,159,67,0.15)' },
  closed: { label: 'Finished', color: 'var(--text-dim)', bg: 'rgba(23,32,70,0.08)' },
  cancelled: { label: 'Cancelled', color: 'var(--kid-pink)', bg: 'rgba(235,87,138,0.12)' },
};

function fmtLeft(ms: number) {
  if (ms <= 0) return '0:00';
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function nameOf(p: BattleParticipant) {
  return p.nickname || 'A player';
}

// One clock for the whole detail view, so the phase panel, the turn banner and
// the countdown all read the same instant.
function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function EntryCanvas({ strokes, rev, height = 120 }: { strokes: Stroke[] | null | undefined; rev?: number | string; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) renderStrokesToCanvas(ref.current, strokes || []);
  }, [strokes, rev]);
  return <canvas ref={ref} width={160} height={height} style={{ width: 160, height, borderRadius: 10, border: '1px solid var(--chip-border)', background: '#fff' }} />;
}

function StatusPill({ status }: { status: BattlePhase }) {
  const m = PHASE_META[status] || PHASE_META.closed;
  return (
    <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.4, textTransform: 'uppercase', color: m.color, background: m.bg, padding: '3px 8px', borderRadius: 999, whiteSpace: 'nowrap' }}>
      {m.label}
    </span>
  );
}

type BattleTab = 'live' | 'create' | 'results';
function SegTabs({ tabs, active, onSelect }: { tabs: { key: BattleTab; label: string; badge?: number }[]; active: BattleTab; onSelect: (k: BattleTab) => void }) {
  return (
    <div style={{ display: 'flex', background: 'rgba(23,32,70,0.06)', borderRadius: 12, padding: 3, gap: 2, marginBottom: 12 }}>
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onSelect(t.key)}
          style={{
            flex: 1,
            border: 'none',
            padding: '8px 6px',
            borderRadius: 9,
            fontSize: 12.5,
            fontWeight: 700,
            cursor: 'pointer',
            background: active === t.key ? '#fff' : 'transparent',
            color: active === t.key ? 'var(--text)' : 'var(--text-dim)',
            boxShadow: active === t.key ? '0 1px 4px rgba(23,32,70,0.12)' : 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
          }}
        >
          <span>{t.label}</span>
          {typeof t.badge === 'number' && t.badge > 0 && (
            <span style={{ fontSize: 9.5, fontWeight: 800, color: 'var(--accent)', background: 'rgba(47,155,255,0.14)', borderRadius: 999, padding: '1px 6px' }}>
              {t.badge}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function TimeBar({ end, windowMs, color, now }: { end: number; windowMs: number; color: string; now: number }) {
  const left = Math.max(0, end - now);
  const pct = windowMs > 0 ? Math.max(0, Math.min(1, left / windowMs)) : 0;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '4px 0 4px' }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text)' }}><Timer size={12} style={{ verticalAlign: -1 }} /> {fmtLeft(left)} left</span>
      </div>
      <div style={{ height: 5, background: 'rgba(23,32,70,0.08)', borderRadius: 99, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct * 100}%`, background: color, borderRadius: 99, transition: 'width 1s linear' }} />
      </div>
    </div>
  );
}

function InfoTip({ children, icon }: { children: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10.5, color: 'var(--text-dim)', background: 'rgba(47,155,255,0.07)', border: '1px solid rgba(47,155,255,0.2)', borderRadius: 10, padding: '7px 9px', marginTop: 10, lineHeight: 1.5 }}>
      {icon && <span style={{ marginRight: 5, verticalAlign: -2 }}>{icon}</span>}
      {children}
    </div>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ border: '1px solid var(--chip-border)', borderRadius: 12, padding: 12, background: '#fff', marginTop: 10 }}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase panels — one clear panel per phase
// ---------------------------------------------------------------------------

function MiniRoster({ battle, side, now }: { battle: BattleDetail; side: BattleSide; now: number }) {
  const turn = battle.turn[side];
  const info = sideInfoOf(battle, side);
  const people = battle.participants.filter((p) => p.side === side);
  const turnName = turn?.userId ? battle.participants.find((p) => p.userId === turn.userId) : null;
  return (
    <div style={{ border: '1px solid var(--chip-border)', borderRadius: 10, padding: 9, background: '#fff', minWidth: 0, flex: 1 }}>
      <div style={{ fontSize: 11.5, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {info.emoji} {info.name}{battle.mySide === side && <span style={{ fontSize: 9, color: 'var(--accent)', fontWeight: 800 }}> · YOU</span>}
      </div>
      <div style={{ fontSize: 9.5, color: 'var(--text-dim)', margin: '3px 0 5px' }}>
        {battle.accepted[side]} joined
        {turn && battle.phase !== 'inviting' && <> · {isTurnLive(turn, now) ? 'drawing now' : 'waiting'}</>}
      </div>
      {people.map((p) => (
        <div key={p.userId} style={{ fontSize: 10, color: p.status === 'declined' ? 'var(--text-dim)' : 'var(--text)', display: 'flex', alignItems: 'center', gap: 4, padding: '1px 0' }}>
          <span style={{ opacity: p.status === 'declined' ? 0.5 : 1 }}>{p.avatar || '🙂'}</span>
          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>{nameOf(p)}{p.you ? ' (you)' : ''}</span>
          {p.status === 'declined' ? (
            <span style={{ color: 'var(--kid-pink)', fontWeight: 700 }}>out</span>
          ) : p.status === 'pending' ? (
            <span style={{ color: 'var(--text-dim)', fontWeight: 700 }}>invited</span>
          ) : p.ready ? (
            <Check size={11} style={{ color: 'var(--kid-green)' }} />
          ) : (
            <span style={{ color: 'var(--text-dim)' }}>○</span>
          )}
        </div>
      ))}
      {battle.phase === 'drawing' && turnName && (
        <div style={{ fontSize: 9.5, color: 'var(--accent)', fontWeight: 700, marginTop: 4 }}>
          {isTurnLive(turn, now) ? '● drawing now' : `● next: ${turnName.you ? 'you' : nameOf(turnName)}`}
        </div>
      )}
    </div>
  );
}

function InvitingStage({ battle, now, busy, onRespond }: { battle: BattleDetail; now: number; busy: boolean; onRespond: (accept: boolean) => void }) {
  const me = battle.participants.find((p) => p.you);
  const status = me?.status || 'pending';
  const pending = battle.participants.filter((p) => p.status === 'pending').length;
  const organiser = battle.createdBy ? battle.participants.find((p) => p.userId === battle.createdBy) : null;

  return (
    <Panel>
      <div style={{ fontSize: 13, fontWeight: 800 }}>
        <Hourglass size={14} style={{ color: 'var(--kid-blue)', verticalAlign: -2 }} /> Waiting for players to answer
      </div>
      <TimeBar end={battle.invitesEndsAt} windowMs={Math.max(1000, battle.invitesEndsAt - battle.createdAt)} color="var(--kid-blue)" now={now} />
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6 }}>
        {pending} invitation{pending === 1 ? '' : 's'} still open. Unanswered players drop out when the timer ends — the battle starts anyway.
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <MiniRoster battle={battle} side="A" now={now} />
        <MiniRoster battle={battle} side="B" now={now} />
      </div>
      <div style={{ fontSize: 11, fontWeight: 700, marginTop: 10 }}>
        You:{' '}
        {status === 'accepted' && <span style={{ color: 'var(--kid-green)' }}><Check size={12} style={{ verticalAlign: -2 }} /> you&rsquo;re in</span>}
        {status === 'declined' && <span style={{ color: 'var(--kid-pink)' }}>you declined</span>}
        {status === 'pending' && <span style={{ color: 'var(--text-dim)' }}>you haven&rsquo;t answered</span>}
        {organiser && <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}> · set up by {organiser.you ? 'you' : nameOf(organiser)}</span>}
      </div>
      {status === 'pending' && (
        <div className="flex gap-1.5" style={{ marginTop: 9 }}>
          <button className="gbtn" style={{ flex: 1, justifyContent: 'center', background: 'var(--kid-green)', color: '#fff', fontWeight: 800 }} onClick={() => onRespond(true)} disabled={busy}>
            <UserPlus size={14} /> Accept
          </button>
          <button className="gbtn" style={{ flex: 1, justifyContent: 'center', color: 'var(--kid-pink)' }} onClick={() => onRespond(false)} disabled={busy}>
            Decline
          </button>
        </div>
      )}
      {status === 'accepted' && (
        <InfoTip icon={<AlertCircle size={11} />}>
          Declining a battle only takes <b>you</b> out of it — your group and everyone else&rsquo;s stay exactly as they are.
        </InfoTip>
      )}
      {status === 'declined' && (
        <InfoTip icon={<AlertCircle size={11} />}>
          You&rsquo;re out of <b>this battle only</b> — you&rsquo;re still in your group, and the battle carries on without you.
        </InfoTip>
      )}
    </Panel>
  );
}

function ReadyStage({ battle, now, busy, onReady }: { battle: BattleDetail; now: number; busy: boolean; onReady: () => void }) {
  const me = battle.participants.find((p) => p.you);
  const waiting = battle.participants.filter((p) => p.status === 'accepted' && !p.ready);

  return (
    <Panel>
      <div style={{ fontSize: 13, fontWeight: 800 }}>
        <Sparkles size={14} style={{ color: 'var(--kid-yellow)', verticalAlign: -2 }} /> Get ready to draw
      </div>
      <TimeBar end={battle.readyEndsAt} windowMs={READY_WINDOW_MS} color="var(--kid-yellow)" now={now} />
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6 }}>
        {waiting.length
          ? `Waiting for ${waiting.map((p) => (p.you ? 'you' : nameOf(p))).join(', ')}. The battle starts the moment everyone is ready.`
          : 'Everyone is ready — starting now.'}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <MiniRoster battle={battle} side="A" now={now} />
        <MiniRoster battle={battle} side="B" now={now} />
      </div>
      {me?.status === 'accepted' ? (
        <button className="gbtn" style={{ width: '100%', justifyContent: 'center', marginTop: 10, background: me.ready ? 'var(--kid-green)' : 'var(--accent)', color: '#fff', fontWeight: 800 }} onClick={onReady} disabled={busy || me.ready}>
          {me.ready ? <><Check size={14} /> You&rsquo;re ready</> : busy ? 'Marking…' : 'I’m Ready'}
        </button>
      ) : (
        <InfoTip icon={<AlertCircle size={11} />}>
          You&rsquo;re not drawing in this one, so there&rsquo;s nothing to ready up. Watch it here from the sidelines.
        </InfoTip>
      )}
    </Panel>
  );
}

function CountdownStage({ battle, now }: { battle: BattleDetail; now: number }) {
  const left = Math.max(0, battle.countdownEndsAt - now);
  const label = left > 0 ? String(Math.min(3, Math.max(1, Math.ceil(left / (COUNTDOWN_MS / 3))))) : 'Go!';
  return (
    <Panel>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-dim)' }}>Get your brushes…</div>
        <div style={{ fontSize: 52, fontWeight: 800, lineHeight: 1.15, color: 'var(--accent2)', margin: '4px 0' }}>{label}</div>
        <div style={{ fontSize: 12, fontWeight: 700 }}>
          {battle.kind === 'duel' ? 'Draw the prompt — you have the whole window' : 'Turn order is set'}
        </div>
        <div style={{ fontSize: 10.5, color: 'var(--text-dim)', marginTop: 4 }}>
          {sideInfoOf(battle, 'A').emoji} {sideInfoOf(battle, 'A').name} <span style={{ color: 'var(--text-dim)' }}>vs</span> {sideInfoOf(battle, 'B').emoji} {sideInfoOf(battle, 'B').name}
        </div>
      </div>
    </Panel>
  );
}

function DrawingStage({
  battle,
  entries,
  now,
  getStrokes,
  setStrokes,
  onChanged,
}: {
  battle: BattleDetail;
  entries: BattleEntry[];
  now: number;
  getStrokes: () => Stroke[];
  setStrokes: (s: Stroke[]) => void;
  onChanged: () => void;
}) {
  const api = useApi();
  const isDuel = battle.kind === 'duel';
  const me = battle.participants.find((p) => p.you);
  const mySide = battle.mySide;
  const turn = battle.myTurn;
  const turnLive = isTurnLive(turn, now) && !me?.turnEnded;
  const myEntry = mySide ? entryOf(entries, mySide) : null;
  const submitted = Boolean(myEntry?.submittedAt || me?.submitted);

  const [started, setStarted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [syncError, setSyncError] = useState('');
  // How much of the local canvas the server already has, and which revision of
  // the shared entry that was. Seeded when the turn is taken, not before.
  const pushedRef = useRef(0);
  const entryRevRef = useRef(0);
  const turnKey = `${battle.id}:${turn?.index ?? -1}`;
  // The engine accessors are re-created on every stroke, so the sync timer must
  // read them through a ref or it would restart on each mark and never fire.
  const canvasRef = useRef({ get: getStrokes, set: setStrokes });
  useEffect(() => {
    canvasRef.current.get = getStrokes;
    canvasRef.current.set = setStrokes;
  }, [getStrokes, setStrokes]);

  useEffect(() => {
    setStarted(false);
    setSyncError('');
  }, [turnKey]);

  const pushDelta = useCallback(async () => {
    const delta = canvasRef.current.get().slice(pushedRef.current);
    if (!delta.length) return true;
    try {
      const d = await api.post(`/api/competitions/${battle.id}`, {
        action: 'sync',
        from: entryRevRef.current,
        strokes: delta,
      });
      pushedRef.current += delta.length;
      if (typeof d?.entryRev === 'number') entryRevRef.current = d.entryRev;
      setSyncError('');
      return true;
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : 'Those strokes were not saved.');
      return false;
    }
  }, [api, battle.id]);

  // The turn owner syncs the strokes added since the last push. Nobody else
  // sends anything, and a 1v1 never syncs at all. The pusher is read through a
  // ref so the once-per-second clock cannot restart the timer.
  const pushRef = useRef(pushDelta);
  useEffect(() => {
    pushRef.current = pushDelta;
  }, [pushDelta]);

  useEffect(() => {
    if (isDuel || !started || !turnLive) return;
    const t = setInterval(() => {
      if (!document.hidden) void pushRef.current();
    }, SYNC_EVERY_MS);
    return () => clearInterval(t);
  }, [isDuel, started, turnLive, turnKey]);

  async function startTurn() {
    if (!mySide) return;
    if (canvasRef.current.get().length && !window.confirm('Starting your turn replaces what is on your canvas with your team’s artwork. Continue?')) return;
    setBusy(true);
    try {
      const d = await api.get(`/api/competitions/${battle.id}?strokes=1`);
      const mine = entryOf(d.entries || [], mySide);
      const team = mine?.strokes || [];
      canvasRef.current.set(team);
      pushedRef.current = team.length;
      entryRevRef.current = mine?.rev || 0;
      setStarted(true);
      setSyncError('');
      onChanged();
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : 'Could not load your team’s drawing.');
    } finally {
      setBusy(false);
    }
  }

  async function endTurn() {
    setBusy(true);
    try {
      // The last strokes go up before the slot closes. If they did not land, the
      // slot stays open on purpose — ending it here would throw the work away.
      if (!(await pushDelta())) return;
      await api.post(`/api/competitions/${battle.id}`, { action: 'endTurn' });
      setStarted(false);
      onChanged();
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : 'Could not finish your turn.');
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    setBusy(true);
    try {
      await api.post(`/api/competitions/${battle.id}`, { action: 'submit', strokes: canvasRef.current.get() });
      onChanged();
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : 'Could not submit your drawing.');
    } finally {
      setBusy(false);
    }
  }

  const teamStrokes = myEntry?.strokes || null;
  // Whose turn it is on my team right now (my own slot is only mine to read, so
  // the side window is what names the player whose turn this is).
  const sideTurn = mySide ? battle.turn[mySide] : null;
  const onDeck = sideTurn?.userId ? battle.participants.find((p) => p.userId === sideTurn.userId) : null;
  const mineIn = turn && turn.startsAt > now ? turn.startsAt - now : 0;

  return (
    <>
      <Panel>
        <div style={{ fontSize: 13, fontWeight: 800 }}>
          <Sparkles size={14} style={{ color: 'var(--kid-yellow)', verticalAlign: -2 }} /> Drawing
        </div>
        <TimeBar end={battle.drawEndsAt} windowMs={Math.max(1000, battle.drawEndsAt - battle.drawStartAt)} color="var(--accent)" now={now} />

        {isDuel ? (
          <>
            <div style={{ fontSize: 11.5, fontWeight: 700, marginTop: 8, color: turnLive ? 'var(--accent)' : 'var(--text-dim)' }}>
              {turnLive ? 'Your drawing board is open' : `Your slot runs ${fmtLeft(Math.max(0, (turn?.startsAt || 0) - now))} from now`}
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 8 }}>
              <EntryCanvas strokes={getStrokes()} rev={now} height={150} />
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', textAlign: 'center', marginTop: 4 }}>
              This is your canvas right now — a live preview of what you&rsquo;ll submit.
            </div>
            {submitted ? (
              <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--kid-green)', display: 'flex', alignItems: 'center', gap: 6, marginTop: 10 }}>
                <Check size={16} /> Drawing submitted — good luck!
              </div>
            ) : (
              <button className="gbtn" style={{ width: '100%', justifyContent: 'center', marginTop: 10, background: 'var(--kid-green)', color: '#fff', fontWeight: 800 }} onClick={submit} disabled={busy}>
                {busy ? 'Submitting…' : 'Submit my drawing'}
              </button>
            )}
            <InfoTip icon={<Sparkles size={11} />}>
              Draw <b>“{battle.prompt}”</b> on your main canvas, then submit. Your rival draws on their own — nobody sees each other&rsquo;s work until voting.
            </InfoTip>
          </>
        ) : mySide ? (
          <>
            {turnLive ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 800, color: 'var(--accent)', marginTop: 8 }}>
                <Play size={13} /> You&rsquo;re up — {fmtLeft((turn?.endsAt || 0) - now)} left
              </div>
            ) : (
              <div style={{ fontSize: 11.5, fontWeight: 700, marginTop: 8, color: 'var(--text-dim)' }}>
                {!onDeck
                  ? 'Your team has no drawing slot.'
                  : onDeck.you
                    ? 'Your slot is over'
                    : `${onDeck.avatar || '🙂'} ${nameOf(onDeck)}’s turn`}
                {mineIn > 0 && <> · yours in {fmtLeft(mineIn)}</>}
              </div>
            )}

            {turnLive && !submitted && (
              started ? (
                <>
                  <button className="gbtn" style={{ width: '100%', justifyContent: 'center', marginTop: 9, background: 'var(--kid-green)', color: '#fff', fontWeight: 800 }} onClick={endTurn} disabled={busy}>
                    <Flag size={14} /> {busy ? 'Saving…' : 'Done with my turn'}
                  </button>
                  <div style={{ fontSize: 9.5, color: 'var(--text-dim)', textAlign: 'center', marginTop: 4 }}>
                    Your team&rsquo;s artwork is live and syncs as you draw.
                  </div>
                </>
              ) : (
                <button className="gbtn" style={{ width: '100%', justifyContent: 'center', marginTop: 9, background: 'var(--accent)', color: '#fff', fontWeight: 800 }} onClick={startTurn} disabled={busy}>
                  <Play size={14} /> {busy ? 'Loading…' : 'Start my turn'}
                </button>
              )
            )}

            {!turnLive && (
              <div style={{ textAlign: 'center', marginTop: 9 }}>
                <EntryCanvas strokes={teamStrokes} rev={myEntry?.rev} height={140} />
                <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>
                  {sideInfoOf(battle, mySide).emoji} {sideInfoOf(battle, mySide).name} so far — {myEntry?.strokeCount || 0} stroke{myEntry?.strokeCount === 1 ? '' : 's'}
                </div>
              </div>
            )}

            {syncError && (
              <div style={{ fontSize: 10.5, color: 'var(--kid-pink)', marginTop: 8 }}>
                <AlertCircle size={12} style={{ verticalAlign: -2 }} /> {syncError}
              </div>
            )}
            <InfoTip icon={<Users size={11} />}>
              Everyone on your team draws on <b>one shared canvas</b>, one turn at a time. Start your turn to load what your team has drawn, add to it, then press <b>Done with my turn</b>.
            </InfoTip>
          </>
        ) : (
          <InfoTip icon={<AlertCircle size={11} />}>
            You&rsquo;re not drawing in this battle — you can watch both teams here.
          </InfoTip>
        )}
      </Panel>

      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <MiniRoster battle={battle} side="A" now={now} />
        <MiniRoster battle={battle} side="B" now={now} />
      </div>
    </>
  );
}

function VotingStage({ battle, entries, now, onVoted }: { battle: BattleDetail; entries: BattleEntry[]; now: number; onVoted: () => void }) {
  const api = useApi();
  const [busy, setBusy] = useState<BattleSide | null>(null);
  const [error, setError] = useState('');
  const total = (battle.votes?.A || 0) + (battle.votes?.B || 0);

  async function vote(side: BattleSide) {
    if (busy) return;
    setBusy(side);
    setError('');
    try {
      await api.post(`/api/competitions/${battle.id}`, { action: 'vote', side });
      onVoted();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Vote failed.');
    } finally {
      setBusy(null);
    }
  }

  const card = (side: BattleSide) => {
    const info = sideInfoOf(battle, side);
    const entry = entryOf(entries, side);
    const votes = side === 'A' ? battle.votes?.A || 0 : battle.votes?.B || 0;
    const pct = total ? Math.round((votes / total) * 100) : 0;
    const mine = battle.mySide === side;
    return (
      <div key={side} style={{ textAlign: 'center' }}>
        <EntryCanvas strokes={entry?.strokes} rev={entry?.rev} height={150} />
        <div style={{ fontSize: 12, fontWeight: 800, margin: '6px 0 2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 160 }}>
          {info.emoji} {info.name}{mine ? ' · you' : ''}
        </div>
        <div style={{ fontSize: 10.5, color: 'var(--text-dim)', marginBottom: 4 }}>
          {entry?.strokeCount || 0} stroke{entry?.strokeCount === 1 ? '' : 's'} · {votes} vote{votes === 1 ? '' : 's'} · {pct}%
        </div>
        <div style={{ height: 4, background: 'rgba(23,32,70,0.08)', borderRadius: 99, overflow: 'hidden', marginBottom: 8 }}>
          <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent2)', borderRadius: 99 }} />
        </div>
        {!battle.hasVoted ? (
          <button className="gbtn" style={{ width: '100%', justifyContent: 'center', background: 'var(--accent2)', color: '#fff', fontWeight: 700 }} onClick={() => vote(side)} disabled={busy !== null}>
            <Vote size={13} /> {busy === side ? 'Voting…' : `Vote ${info.name}`}
          </button>
        ) : (
          <div style={{ fontSize: 11, color: battle.myVote === side ? 'var(--kid-green)' : 'var(--text-dim)', fontWeight: 700 }}>
            <Check size={12} style={{ verticalAlign: -2 }} />
            {battle.myVote === side ? 'You voted here' : 'Vote locked in'}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <Panel>
        <div style={{ fontSize: 13, fontWeight: 800 }}>
          <Vote size={14} style={{ color: 'var(--accent2)', verticalAlign: -2 }} /> Voting is open
        </div>
        <TimeBar end={battle.voteEndsAt} windowMs={Math.max(1000, battle.voteEndsAt - battle.drawEndsAt)} color="var(--accent2)" now={now} />
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 10 }}>
          {card('A')}
          {card('B')}
        </div>
        {error && <div style={{ fontSize: 10.5, color: 'var(--kid-pink)', marginTop: 8 }}><AlertCircle size={12} style={{ verticalAlign: -2 }} /> {error}</div>}
      </Panel>
      <InfoTip icon={<Vote size={11} />}>
        One vote each — pick either side. When voting closes the winner is decided automatically and tallied on both sides.
      </InfoTip>
    </>
  );
}

function ResultStage({ battle, entries }: { battle: BattleDetail; entries: BattleEntry[] }) {
  const a = sideInfoOf(battle, 'A');
  const b = sideInfoOf(battle, 'B');
  return (
    <>
      <Panel>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 15, fontWeight: 800 }}>
            <Trophy size={17} style={{ color: 'var(--kid-yellow)', verticalAlign: -3 }} />
            {battle.winner ? `${sideInfoOf(battle, battle.winner).name} wins!` : 'It’s a tie!'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 3 }}>
            {a.emoji} {a.name} {battle.votes?.A || 0} · {b.emoji} {b.name} {battle.votes?.B || 0} votes
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 12 }}>
          {(['A', 'B'] as BattleSide[]).map((side) => {
            const info = sideInfoOf(battle, side);
            const entry = entryOf(entries, side);
            return (
              <div key={side} style={{ textAlign: 'center' }}>
                <EntryCanvas strokes={entry?.strokes} rev={entry?.rev} height={150} />
                <div style={{ fontSize: 12, fontWeight: 800, margin: '6px 0 2px' }}>
                  {battle.winner === side && <Crown size={12} style={{ color: 'var(--kid-yellow)', verticalAlign: -1 }} />} {info.emoji} {info.name}
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>{side === 'A' ? battle.votes?.A || 0 : battle.votes?.B || 0} votes</div>
              </div>
            );
          })}
        </div>
      </Panel>
    </>
  );
}

function CancelledStage({ battle }: { battle: BattleDetail }) {
  return (
    <Panel>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--kid-pink)' }}>
          <AlertCircle size={16} style={{ verticalAlign: -3 }} /> Battle cancelled
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 4 }}>
          {CANCEL_REASON_TEXT[battle.cancelReason] || 'This battle did not run.'}
        </div>
        <div style={{ fontSize: 11, marginTop: 8 }}>
          {sideInfoOf(battle, 'A').emoji} {sideInfoOf(battle, 'A').name} <span style={{ color: 'var(--text-dim)' }}>vs</span> {sideInfoOf(battle, 'B').emoji} {sideInfoOf(battle, 'B').name}
        </div>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Detail view — one poll of metadata, and pixel data only when it is needed
// ---------------------------------------------------------------------------

function BattleView({
  id,
  getStrokes,
  setStrokes,
  onBack,
  onChange,
}: {
  id: string;
  getStrokes: () => Stroke[];
  setStrokes: (s: Stroke[]) => void;
  onBack: () => void;
  onChange?: () => void;
}) {
  const api = useApi();
  const now = useNow();
  const [battle, setBattle] = useState<BattleDetail | null>(null);
  const [entries, setEntries] = useState<BattleEntry[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const fetchedRevRef = useRef(-1);

  const loadMeta = useCallback(async () => {
    try {
      const d = await api.get(`/api/competitions/${id}`);
      setBattle(d);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load battle.');
    } finally {
      setLoaded(true);
    }
  }, [api, id]);

  useEffect(() => {
    void loadMeta();
  }, [loadMeta]);

  // A different battle is a different document: nothing carries over.
  useEffect(() => {
    setBattle(null);
    setEntries([]);
    setError('');
    fetchedRevRef.current = -1;
  }, [id]);

  // Fast while people are drawing, calm everywhere else, stopped for good on a
  // finished battle, and never while the tab is in the background.
  const phase = battle?.phase;
  useEffect(() => {
    if (!phase) return;
    const ms = pollIntervalFor(phase);
    if (!ms) return;
    const t = setInterval(() => {
      if (!document.hidden) void loadMeta();
    }, ms);
    const onVisible = () => {
      if (!document.hidden) void loadMeta();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [loadMeta, phase]);

  const me = battle?.participants.find((p) => p.you);
  const turnLive = isTurnLive(battle?.myTurn, now) && !me?.turnEnded;
  const needsPixels = battle ? phaseNeedsPixels(battle.phase, turnLive) : false;

  // The one request that carries pixels. Gated on the battle having actually
  // changed, so a poll in a phase that needs no artwork costs nothing.
  useEffect(() => {
    if (!battle || !needsPixels) {
      fetchedRevRef.current = -1;
      return;
    }
    if (fetchedRevRef.current === battle.rev) return;
    fetchedRevRef.current = battle.rev;
    let cancelled = false;
    void api
      .get(`/api/competitions/${id}?strokes=1`)
      .then((d) => {
        if (!cancelled) setEntries(d.entries || []);
      })
      .catch(() => {
        // Not fatal — the panel falls back to stroke counts. Forget the revision
        // so the next poll tries again instead of waiting for it to move.
        if (!cancelled) fetchedRevRef.current = -1;
      });
    return () => {
      cancelled = true;
    };
  }, [api, id, battle, needsPixels]);

  async function act(body: Record<string, unknown>, after?: () => void) {
    setBusy(true);
    try {
      await api.post(`/api/competitions/${id}`, body);
      await loadMeta();
      after?.();
      onChange?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  if (!battle) {
    return (
      <div>
        <div className="gbtn" style={{ width: 'auto', padding: '5px 10px', marginBottom: 8 }} onClick={onBack}>← Back to battles</div>
        {error ? (
          <div style={{ background: 'rgba(235,87,138,0.08)', border: '1px solid rgba(235,87,138,0.3)', borderRadius: 10, padding: 10, fontSize: 11.5, color: 'var(--kid-pink)', marginTop: 8 }}>
            <AlertCircle size={13} style={{ verticalAlign: -2 }} /> {error}
            <button className="gbtn" style={{ width: '100%', justifyContent: 'center', marginTop: 8 }} onClick={() => void loadMeta()}>Retry</button>
          </div>
        ) : (
          <div className="stat-row" style={{ marginTop: 8 }}>Loading battle… <RefreshCw size={12} /></div>
        )}
      </div>
    );
  }

  const a = sideInfoOf(battle, 'A');
  const b = sideInfoOf(battle, 'B');
  const canCancel = Boolean(me?.you && battle.createdBy === me.userId && !battle.countdownEndsAt && battle.phase !== 'cancelled');

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div className="gbtn" style={{ width: 'auto', padding: '5px 10px' }} onClick={onBack}>← Back</div>
        <div style={{ flex: 1 }} />
        {canCancel && (
          <div className="gbtn" style={{ width: 'auto', padding: '5px 10px', color: 'var(--kid-pink)' }} onClick={() => { if (confirm('Cancel this battle for everyone?')) void act({ action: 'cancel' }); }}>
            Cancel battle
          </div>
        )}
      </div>

      <div style={{ border: '1px solid var(--chip-border)', borderRadius: 12, padding: 12, background: '#fff', marginTop: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 800, lineHeight: 1.35 }}>&ldquo;{battle.prompt}&rdquo;</div>
          <StatusPill status={battle.phase} />
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 6 }}>
          {a.emoji} {a.name} <b style={{ color: 'var(--text)' }}>vs</b> {b.emoji} {b.name}
          {battle.kind === 'duel' && <span style={{ fontSize: 10, fontWeight: 700 }}> · 1v1</span>}
        </div>
        {error && (
          <div style={{ fontSize: 10.5, color: 'var(--kid-pink)', marginTop: 7 }}>
            <AlertCircle size={12} style={{ verticalAlign: -2 }} /> {error}
          </div>
        )}
      </div>

      {battle.phase === 'inviting' && (
        <InvitingStage
          battle={battle}
          now={now}
          busy={busy}
          onRespond={(accept) => void act({ action: 'respond', accept })}
        />
      )}
      {battle.phase === 'ready' && (
        <ReadyStage battle={battle} now={now} busy={busy} onReady={() => void act({ action: 'ready' })} />
      )}
      {battle.phase === 'countdown' && <CountdownStage battle={battle} now={now} />}
      {battle.phase === 'drawing' && (
        <DrawingStage
          battle={battle}
          entries={entries}
          now={now}
          getStrokes={getStrokes}
          setStrokes={setStrokes}
          onChanged={() => void loadMeta()}
        />
      )}
      {battle.phase === 'voting' && (
        <VotingStage battle={battle} entries={entries} now={now} onVoted={() => void loadMeta()} />
      )}
      {battle.phase === 'closed' && <ResultStage battle={battle} entries={entries} />}
      {battle.phase === 'cancelled' && <CancelledStage battle={battle} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export default function CompetitionsModal({ onClose, sourceGroup, getStrokes, setStrokes, canBattle = true, onChange }: Props) {
  const api = useApi();
  const [active, setActive] = useState<BattleSummary[]>([]);
  const [recent, setRecent] = useState<BattleSummary[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [tab, setTab] = useState<BattleTab>('live');
  const [mode, setMode] = useState<'group' | 'duel'>('group');
  const [openId, setOpenId] = useState<string | null>(null);
  const [srcId, setSrcId] = useState('');
  const [tgtId, setTgtId] = useState('');
  const [opponentId, setOpponentId] = useState('');
  const [prompt, setPrompt] = useState(BATTLE_PROMPTS[0]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const failCountRef = useRef(0);

  const load = useCallback(async () => {
    try {
      const d = await api.get('/api/competitions');
      setActive(d.active || []);
      setRecent(d.recent || []);
      failCountRef.current = 0;
      setError('');
      try {
        const g = await api.get('/api/groups');
        setGroups(g.groups || []);
        setFriends(g.friends || []);
      } catch {
        // Groups and friends are only needed for the "New Battle" form; a
        // hiccup here must not flash an error over the fights list.
      }
    } catch (e) {
      // One transient failure (cold start, Atlas blip) is fine — the user just
      // sees the last good list. Only after repeated failures do we surface the
      // banner with a Retry action.
      failCountRef.current += 1;
      if (failCountRef.current >= 2) {
        setError(e instanceof Error ? e.message : 'Failed to load battles.');
      }
    } finally {
      setLoaded(true);
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (sourceGroup?.id) {
      setTab('create');
      setMode('group');
      setSrcId(sourceGroup.id);
    } else if (groups.length && !srcId) {
      setSrcId(groups[0].id);
    }
  }, [sourceGroup, groups]); // eslint-disable-line react-hooks/exhaustive-deps

  function randomPrompt() {
    setPrompt(BATTLE_PROMPTS[Math.floor(Math.random() * BATTLE_PROMPTS.length)]);
  }

  async function start(body: Record<string, unknown>) {
    let d;
    try {
      d = await api.post('/api/competitions', body);
    } catch (first) {
      // Cold starts can 5xx once; a single retry rides over it. Only retry real
      // server-side failures, never 4xx validation errors.
      if (!/(5\d\d|temporarily unavailable)/.test(first instanceof Error ? first.message : '')) throw first;
      d = await api.post('/api/competitions', body);
    }
    setTab('live');
    setOpenId(d.id);
    onChange?.();
    await load();
  }

  async function createBattle() {
    setError('');
    if (mode === 'duel') {
      if (!opponentId) return setError('Pick a friend to challenge.');
    } else if (!srcId || !tgtId) {
      return setError('Pick your group and a challenger to start.');
    }
    setBusy(true);
    try {
      await start(mode === 'duel' ? { kind: 'duel', opponentId, prompt } : { kind: 'group', sourceGroupId: srcId, targetGroupId: tgtId, prompt });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create battle.');
    } finally {
      setBusy(false);
    }
  }

  if (openId) {
    return (
      <div className="modal-overlay" style={{ zIndex: 90 }}>
        <div className="modal-box" style={{ width: 380, maxWidth: '94vw' }}>
          <div className="close-btn" onClick={() => setOpenId(null)} title="Back"><X size={16} /></div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <div style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--accent)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Swords size={16} />
            </div>
            <h3 style={{ margin: 0 }}>Battle</h3>
          </div>
          <BattleView id={openId} getStrokes={getStrokes} setStrokes={setStrokes} onBack={() => setOpenId(null)} onChange={onChange} />
        </div>
      </div>
    );
  }

  const selectStyle: CSSProperties = { width: '100%' };
  const label = (n: number, t: string) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9.5, fontWeight: 700, color: 'var(--text-dim)' }}>
      <span style={{ width: 16, height: 16, borderRadius: 99, background: n === 1 ? 'var(--accent)' : 'rgba(23,32,70,0.08)', color: n === 1 ? '#fff' : 'var(--text-dim)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 9 }}>
        {n}
      </span>
      {t}
    </div>
  );
  const connector = () => <span style={{ width: 10, height: 1, background: 'rgba(23,32,70,0.15)' }} />;

  const summaryCard = (b: BattleSummary) => {
    const deadline = deadlineFor(b);
    const remaining = deadline - Date.now();
    return (
      <div
        key={b.id}
        onClick={() => setOpenId(b.id)}
        style={{ border: '1px solid var(--chip-border)', borderRadius: 12, padding: 10, marginBottom: 8, background: '#fff', cursor: 'pointer' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {b.groupA.emoji} {b.groupA.name} <span style={{ color: 'var(--text-dim)', fontWeight: 600 }}>vs</span> {b.groupB.emoji} {b.groupB.name}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              &ldquo;{b.prompt}&rdquo;
            </div>
            {b.mySide && (
              <div style={{ fontSize: 9.5, fontWeight: 800, color: 'var(--accent)', background: PHASE_META[b.status].bg, borderRadius: 999, padding: '2px 7px', display: 'inline-block', marginTop: 5 }}>
                {b.myStatus === 'declined' ? 'You dropped out' : `You're in — ${sideInfoOf(b, b.mySide).name}`}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
            <StatusPill status={b.status} />
            {deadline > 0 && (
              <span style={{ fontSize: 10, color: PHASE_META[b.status].color, fontWeight: 700 }}>
                {remaining > 0 ? `${fmtLeft(remaining)} left` : 'finalising…'}
              </span>
            )}
            <span style={{ fontSize: 10, color: 'var(--accent)', fontWeight: 800 }}>View battle <ChevronRight size={11} style={{ verticalAlign: -2 }} /></span>          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="modal-overlay" style={{ zIndex: 90 }}>
      <div className="modal-box" style={{ width: 400, maxWidth: '94vw' }}>
        <div className="close-btn" onClick={onClose} title="Close"><X size={16} /></div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
          <div style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--accent)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Swords size={16} />
          </div>
          <h3 style={{ margin: 0 }}>Battles</h3>
        </div>
        <div style={{ fontSize: 10.5, color: 'var(--text-dim)', marginBottom: 10 }}>
          A group duel, or a straight 1v1 with a friend — same prompt for both sides, then everyone votes.
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
          <div className="gmini" title="Refresh" onClick={() => { setLoaded(false); void load(); }}><RefreshCw size={13} /></div>
        </div>

        <SegTabs
          tabs={[
            { key: 'live', label: 'Live', badge: active.length },
            { key: 'create', label: 'New Battle' },
            { key: 'results', label: 'Results' },
          ]}
          active={tab}
          onSelect={setTab}
        />

        {error && (
          <div style={{ background: 'rgba(235,87,138,0.08)', border: '1px solid rgba(235,87,138,0.3)', borderRadius: 10, padding: 9, fontSize: 11.5, color: 'var(--kid-pink)', marginBottom: 8 }}>
            <AlertCircle size={13} style={{ verticalAlign: -2 }} /> {error}
            <button className="gbtn" style={{ width: '100%', justifyContent: 'center', marginTop: 7 }} onClick={() => { setLoaded(false); void load(); }}>Retry</button>
          </div>
        )}

        {tab === 'live' && (
          <>
            {!loaded && <div className="stat-row">Loading battles…</div>}
            <div style={{ maxHeight: 300, overflowY: 'auto' }}>
              {active.map((b) => summaryCard(b))}
              {loaded && !active.length && (
                <div style={{ textAlign: 'center', padding: '18px 10px' }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>No live battles</div>
                  <div style={{ fontSize: 11, color: 'var(--text-dim)', margin: '4px 0 10px' }}>Challenge a friend 1v1, or another group, and the duel shows up here.</div>
                  {canBattle ? (
                    <button className="gbtn" style={{ justifyContent: 'center', background: 'var(--accent)', color: '#fff' }} onClick={() => setTab('create')}>Start your first battle</button>
                  ) : (
                    <div style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>Starting battles is not in your current plan.</div>
                  )}
                </div>
              )}
            </div>
          </>
        )}

        {tab === 'create' && (
          <>
            {!canBattle && (
              <div className="stat-row" style={{ marginBottom: 8, color: 'var(--text-dim)' }}>
                Starting battles is not included on your current plan.
              </div>
            )}

            <div className="flex gap-1.5 mb-2">
              <div className="gbtn" style={{ flex: 1, justifyContent: 'center' }} onClick={() => setMode('group')}>
                <Users size={14} /> Group vs group
              </div>
              <div className="gbtn" style={{ flex: 1, justifyContent: 'center' }} onClick={() => setMode('duel')}>
                <UserPlus size={14} /> Challenge a friend
              </div>
            </div>

            {mode === 'duel' ? (
              <>
                <div style={{ display: 'flex', gap: 6, marginBottom: 10, alignItems: 'center' }}>
                  {label(1, 'Pick a friend')}{connector()}{label(2, 'Set prompt')}{connector()}{label(3, 'Start')}
                </div>

                <div style={{ fontSize: 10.5, color: 'var(--text-dim)', fontWeight: 700, marginBottom: 4, opacity: canBattle ? 1 : 0.5 }}>
                  1 · Your opponent <span style={{ fontWeight: 400 }}>(only friends you&rsquo;ve added)</span>
                </div>
                {friends.length ? (
                  <select className="field-input" style={selectStyle} value={opponentId} onChange={(e) => setOpponentId(e.target.value)} disabled={!canBattle}>
                    <option value="">Choose…</option>
                    {friends.map((f) => <option key={f.userId} value={f.userId}>{f.avatar || '🙂'} {f.nickname || f.email}</option>)}
                  </select>
                ) : (
                  <div style={{ textAlign: 'center', padding: '14px 10px', border: '1px dashed var(--chip-border)', borderRadius: 12 }}>
                    <UserPlus size={20} style={{ color: 'var(--text-dim)' }} />
                    <div style={{ fontSize: 12.5, fontWeight: 700, margin: '6px 0 2px' }}>You need a friend first</div>
                    <div style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>Add one from Friends, then challenge them to a 1v1 here.</div>
                  </div>
                )}

                <div style={{ fontSize: 10.5, color: 'var(--text-dim)', fontWeight: 700, margin: '10px 0 4px', opacity: canBattle ? 1 : 0.5 }}>2 · Battle prompt <span style={{ fontWeight: 400 }}>(same prompt for both of you)</span></div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input className="field-input" value={prompt} onChange={(e) => setPrompt(e.target.value)} autoComplete="off" disabled={!canBattle} />
                  <div className="gmini" title="Random prompt" onClick={canBattle ? randomPrompt : undefined}><RefreshCw size={14} /></div>
                </div>

                <button className="gbtn" style={{ width: '100%', justifyContent: 'center', marginTop: 12, background: 'var(--accent)', color: '#fff', fontWeight: 800 }} onClick={createBattle} disabled={busy || !canBattle || !friends.length}>
                  {busy ? 'Sending…' : '⚡ Challenge'}
                </button>
              </>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
                  {[
                    { n: 1, t: 'Pick your group' },
                    { n: 2, t: 'Pick a rival' },
                    { n: 3, t: 'Set prompt' },
                    { n: 4, t: 'Start' },
                  ].map((s, i, arr) => (
                    <div key={s.n} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9.5, fontWeight: 700, color: 'var(--text-dim)' }}>
                      {label(s.n, s.t)}
                      {i < arr.length - 1 && connector()}
                    </div>
                  ))}
                </div>

                {!groups.length ? (
                  <div style={{ textAlign: 'center', padding: '16px 10px', border: '1px dashed var(--chip-border)', borderRadius: 12 }}>
                    <Users size={20} style={{ color: 'var(--text-dim)' }} />
                    <div style={{ fontSize: 12.5, fontWeight: 700, margin: '6px 0 2px' }}>You need a group first</div>
                    <div style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>
                      Create a group (friend → group → battle) and it will show up here so you can challenge with it.
                    </div>
                  </div>
                ) : (
                  <>
                    <div style={{ fontSize: 10.5, color: 'var(--text-dim)', fontWeight: 700, marginBottom: 4, opacity: canBattle ? 1 : 0.5 }}>1 · Your group <span style={{ fontWeight: 400 }}>(the one you draw for)</span></div>
                    <select className="field-input" style={selectStyle} value={srcId} onChange={(e) => setSrcId(e.target.value)} disabled={!canBattle}>
                      <option value="">Choose…</option>
                      {groups.map((g) => <option key={g.id} value={g.id}>{g.emoji} {g.name}</option>)}
                    </select>

                    <div style={{ fontSize: 10.5, color: 'var(--text-dim)', fontWeight: 700, margin: '10px 0 4px', opacity: canBattle ? 1 : 0.5 }}>2 · Challenger <span style={{ fontWeight: 400 }}>(another group you're in)</span></div>
                    <select className="field-input" style={selectStyle} value={tgtId} onChange={(e) => setTgtId(e.target.value)} disabled={!canBattle}>
                      <option value="">Choose…</option>
                      {groups.filter((g) => g.id !== srcId).map((g) => <option key={g.id} value={g.id}>{g.emoji} {g.name}</option>)}
                    </select>
                    {groups.length > 1 ? (
                      <div style={{ fontSize: 9.5, color: 'var(--text-dim)', marginTop: 3 }}>You can only challenge groups you're a member of.</div>
                    ) : (
                      <div style={{ fontSize: 9.5, color: 'var(--text-dim)', marginTop: 3 }}>You&rsquo;re in only one group — join or create another to challenge.</div>
                    )}

                    <div style={{ fontSize: 10.5, color: 'var(--text-dim)', fontWeight: 700, margin: '10px 0 4px', opacity: canBattle ? 1 : 0.5 }}>3 · Battle prompt <span style={{ fontWeight: 400 }}>(same prompt for both groups)</span></div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input className="field-input" value={prompt} onChange={(e) => setPrompt(e.target.value)} autoComplete="off" disabled={!canBattle} />
                      <div className="gmini" title="Random prompt" onClick={canBattle ? randomPrompt : undefined}><RefreshCw size={14} /></div>
                    </div>

                    <button className="gbtn" style={{ width: '100%', justifyContent: 'center', marginTop: 12, background: 'var(--accent)', color: '#fff', fontWeight: 800 }} onClick={createBattle} disabled={busy || !canBattle}>
                      {busy ? 'Starting…' : '⚡ Start battle'}
                    </button>
                  </>
                )}
              </>
            )}

            <InfoTip icon={<Swords size={11} />}>
              <b>How battles work:</b> everyone answers the invitation, presses <b>I&rsquo;m Ready</b>, then both sides get <b>5 minutes</b> of drawing. A group battle shares one canvas per team, one turn at a time; a 1v1 keeps your drawing to yourself until voting. Then <b>3 minutes</b> of voting — one vote each — and the winner is decided automatically.
            </InfoTip>
          </>
        )}

        {tab === 'results' && (
          <div style={{ maxHeight: 300, overflowY: 'auto' }}>
            {recent.map((b) => (
              <div key={b.id} onClick={() => setOpenId(b.id)} style={{ border: '1px solid var(--chip-border)', borderRadius: 12, padding: 10, marginBottom: 8, background: '#fff', cursor: 'pointer' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {b.groupA.emoji} {b.groupA.name} <span style={{ color: 'var(--text-dim)' }}>vs</span> {b.groupB.emoji} {b.groupB.name}
                    </div>
                    <div style={{ fontSize: 10.5, color: 'var(--text-dim)', marginTop: 2 }}>{b.votes ? `${b.votes.A} · ${b.votes.B} votes` : ''}</div>
                  </div>
                  <span style={{ fontSize: 11, fontWeight: 800, color: b.status === 'cancelled' ? 'var(--text-dim)' : 'var(--kid-green)', flexShrink: 0 }}>
                    {b.status === 'cancelled'
                      ? 'Cancelled'
                      : b.winner
                        ? `${sideInfoOf(b, b.winner).emoji} ${sideInfoOf(b, b.winner).name} 🏆`
                        : 'Tie'}
                  </span>
                </div>
              </div>
            ))}
            {loaded && !recent.length && <div className="stat-row">No finished battles yet.</div>}
          </div>
        )}
      </div>
    </div>
  );
}
