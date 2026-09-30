import { useCallback, useEffect, useState } from 'react';
import { X, Users, Swords } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { AVATARS } from '../lib/battle';

interface Member {
  userId: string;
  nickname: string;
  email: string;
  avatar: string;
}
export interface Group {
  id: string;
  name: string;
  emoji: string;
  adminId: string;
  wins: number;
  played: number;
  members: Member[];
  // Friends already invited who have not answered yet — they join on accept.
  invited?: { userId: string; inviterId: string; createdAt: number }[];
}
interface Props {
  onClose: () => void;
  onChallenge: (group: Group) => void;
}

export default function GroupsModal({ onClose, onChallenge }: Props) {
  const api = useApi();
  const [groups, setGroups] = useState<Group[]>([]);
  const [friends, setFriends] = useState<Member[]>([]);
  const [tab, setTab] = useState<'list' | 'create'>('list');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState(AVATARS[1] || '🎨');
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api.get('/api/groups');
      setGroups(d.groups || []);
      setFriends(d.friends || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load groups.');
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  async function act(action: string, groupId: string, payload: Record<string, unknown> = {}) {
    setError('');
    setBusy(true);
    try {
      await api.post(`/api/groups/${groupId}`, { action, ...payload });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    setError('');
    if (!name.trim()) return setError('Give your group a name.');
    if (!picked.length) return setError('Add at least one friend to your group.');
    setBusy(true);
    try {
      const d = await api.post('/api/groups', { name: name.trim(), emoji, memberIds: picked });
      setTab('list');
      setName('');
      setPicked([]);
      await load();
      if (d.groupId) setExpanded(d.groupId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create group.');
    } finally {
      setBusy(false);
    }
  }

  const invitedIds = (g: Group) => new Set((g.invited || []).map((i) => i.userId));
  const friendName = (f: Member) => f.nickname || f.email;
  const inGroupNotMember = (g: Group) => friends.filter((f) => !g.members.some((m) => m.userId === f.userId) && !invitedIds(g).has(f.userId));
  const awaitingReply = (g: Group) => {
    const pending = invitedIds(g);
    return friends.filter((f) => !g.members.some((m) => m.userId === f.userId) && pending.has(f.userId));
  };

  return (
    <div className="modal-overlay" style={{ zIndex: 90 }}>
      <div className="modal-box" style={{ width: 350, maxWidth: '94vw' }}>
        <div className="close-btn" onClick={onClose} title="Close"><X size={16} /></div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <div style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--kid-green)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Users size={16} />
          </div>
          <h3 style={{ margin: 0 }}>Groups & Battles</h3>
        </div>

        <div className="flex gap-1.5 mb-2">
          <div className="gbtn" style={{ flex: 1, justifyContent: 'center' }} onClick={() => setTab('list')}>My Groups ({groups.length})</div>
          <div className="gbtn" style={{ flex: 1, justifyContent: 'center' }} onClick={() => setTab('create')}>New Group</div>
        </div>

        {tab === 'create' && (
          <>
            <input className="field-input" placeholder="Group name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
            <div className="flex gap-1 flex-wrap my-2">
              {AVATARS.map((a) => (
                <div key={a} className="gmini" style={{ fontSize: 15, opacity: emoji === a ? 1 : 0.45, background: emoji === a ? 'rgba(var(--kid-green-rgb),0.2)' : undefined }} onClick={() => setEmoji(a)}>
                  {a}
                </div>
              ))}
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--text-dim)', fontWeight: 600, marginBottom: 4 }}>Pick friends to invite (only friends can join)</div>
            <div style={{ maxHeight: 130, overflowY: 'auto', marginBottom: 8 }}>
              {friends.map((f) => (
                <label key={f.userId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', fontSize: 12.5, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={picked.includes(f.userId)}
                    onChange={(e) =>
                      setPicked((prev) => (e.target.checked ? [...prev, f.userId] : prev.filter((u) => u !== f.userId)))
                    }
                  />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{friendName(f)}</span>
                </label>
              ))}
              {!friends.length && <div className="stat-row">You need friends first — no friends to invite.</div>}
            </div>
            <button className="gbtn" style={{ width: '100%', justifyContent: 'center', background: 'var(--kid-green)', color: '#fff' }} onClick={create} disabled={busy}>
              {busy ? 'Creating…' : `Create ${name.trim() ? `“${name.trim()}”` : 'group'}`}
            </button>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 6, lineHeight: 1.5 }}>
              You&rsquo;re added straight away. The friends you picked get an invitation and join when they accept it — they&rsquo;re not members until then.
            </div>
          </>
        )}

        {tab === 'list' && (
          <div style={{ maxHeight: 320, overflowY: 'auto' }}>
            {groups.map((g) => (
              <div key={g.id} style={{ border: '1px solid var(--chip-border)', borderRadius: 10, padding: 8, marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }} onClick={() => setExpanded(expanded === g.id ? null : g.id)}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ fontSize: 18 }}>{g.emoji}</div>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 700 }}>{g.name}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                        {g.members.length} member{g.members.length === 1 ? '' : 's'} · {g.wins}W/{g.played} played
                      </div>
                    </div>
                  </div>
                  <div className="gmini" title="Challenge another group" onClick={(e) => { e.stopPropagation(); onChallenge(g); }}>
                    <Swords size={15} />
                  </div>
                </div>

                {expanded === g.id && (
                  <div style={{ marginTop: 8, paddingTop: 6, borderTop: '1px dashed var(--chip-border)' }}>
                    {g.members.map((m) => (
                      <div key={m.userId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '3px 0', fontSize: 12 }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span>{m.avatar || '🙂'}</span> {m.nickname || m.email}
                          {m.userId === g.adminId && <span style={{ fontSize: 9, color: 'var(--kid-yellow)' }}>creator</span>}
                        </span>
                        {g.adminId === m.userId ? null : (
                          <a style={{ color: 'var(--kid-pink)', fontSize: 11, cursor: 'pointer' }} onClick={() => act('remove', g.id, { memberId: m.userId })}>remove</a>
                        )}
                      </div>
                    ))}

                    {g.adminId && inGroupNotMember(g).map((f) => (
                      <a key={f.userId} style={{ display: 'inline-block', margin: '4px 6px 0 0', fontSize: 11, cursor: busy ? 'default' : 'pointer', color: 'var(--kid-blue)' }} onClick={busy ? undefined : () => act('invite', g.id, { memberId: f.userId })}>
                        + {friendName(f)}
                      </a>
                    ))}

                    {awaitingReply(g).length > 0 && (
                      <div style={{ fontSize: 10.5, color: 'var(--text-dim)', marginTop: 5 }}>
                        ⏳ Invite sent, waiting for {awaitingReply(g).map((f) => friendName(f)).join(', ')} — they join the group when they accept.
                      </div>
                    )}

                    <div className="flex gap-1.5 mt-2">
                      <div className="gbtn" style={{ flex: 1, justifyContent: 'center' }} onClick={() => { if (confirm('Leave this group?')) act('leave', g.id); }}>Leave</div>
                      <div className="gbtn" style={{ flex: 1, justifyContent: 'center', color: 'var(--kid-pink)' }} onClick={() => { if (confirm('Delete this group? This cannot be undone.')) act('delete', g.id); }}>Delete</div>
                      <div className="gbtn" style={{ flex: 1, justifyContent: 'center', color: 'var(--accent2)' }} onClick={() => onChallenge(g)}>Challenge</div>
                    </div>
                  </div>
                )}
              </div>
            ))}
            {!groups.length && <div className="stat-row">No groups yet — create one!</div>}
          </div>
        )}

        {error && <div style={{ fontSize: 11, color: 'var(--kid-pink)', marginTop: 8 }}>{error}</div>}
      </div>
    </div>
  );
}