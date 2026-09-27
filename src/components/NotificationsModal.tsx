import { useCallback, useEffect, useState } from 'react';
import { X, UserPlus, Users, Swords, Check, UserX, Bell } from 'lucide-react';
import { useApi } from '../hooks/useApi';

export interface RequestItem {
  id: string;
  kind: 'friend' | 'group' | 'battle';
  title: string;
  body: string;
  avatar: string;
  createdAt: number;
  accept: boolean;
  decline: boolean;
}

const KIND_META = {
  friend: { Icon: UserPlus, tint: 'var(--kid-yellow)', label: 'Friend request' },
  group: { Icon: Users, tint: 'var(--kid-green)', label: 'Group invitation' },
  battle: { Icon: Swords, tint: 'var(--accent)', label: 'Battle invitation' },
} as const;

function ago(ms: number) {
  if (!ms) return '';
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

interface Props {
  onClose: () => void;
  onChange?: () => void;
}

export default function NotificationsModal({ onClose, onChange }: Props) {
  const api = useApi();
  const [items, setItems] = useState<RequestItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api.get('/api/requests');
      setItems(d.items || []);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load requests.');
    } finally {
      setLoaded(true);
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  async function answer(item: RequestItem, action: 'accept' | 'decline') {
    setError('');
    setBusy(item.id);
    try {
      await api.post('/api/requests', { id: item.id, action });
      // The list is the truth: the answered row disappears from it.
      await load();
      onChange?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
      await load();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="modal-overlay" style={{ zIndex: 90 }}>
      <div className="modal-box" style={{ width: 340, maxWidth: '94vw' }}>
        <div className="close-btn" onClick={onClose} title="Close"><X size={16} /></div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <div style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--accent)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Bell size={16} />
          </div>
          <h3 style={{ margin: 0 }}>Requests</h3>
        </div>
        <div style={{ fontSize: 10.5, color: 'var(--text-dim)', marginBottom: 10 }}>
          Friend requests, group invitations and battle challenges — they wait here until you answer.
        </div>

        {error && <div style={{ fontSize: 11, color: 'var(--kid-pink)', marginBottom: 8 }}>{error}</div>}

        <div style={{ maxHeight: 300, overflowY: 'auto' }}>
          {items.map((item) => {
            const { Icon, tint, label } = KIND_META[item.kind] || KIND_META.friend;
            return (
              <div key={item.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--chip-border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <div style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--kid-yellow)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, flexShrink: 0 }}>
                    {item.avatar || '🙂'}
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {item.title || 'Someone'} <span style={{ fontWeight: 400, color: 'var(--text-dim)' }}>{item.body}</span>
                    </div>
                    <div style={{ fontSize: 10, color: tint, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 4, marginTop: 1 }}>
                      <Icon size={10} /> {label} {ago(item.createdAt) && <span style={{ color: 'var(--text-dim)', fontWeight: 600 }}>· {ago(item.createdAt)}</span>}
                    </div>
                  </div>
                  <div className="flex gap-1.5" style={{ flexShrink: 0 }}>
                    {item.accept && (
                      <div className="gmini" style={{ color: 'var(--kid-green)' }} title="Accept" onClick={() => !busy && answer(item, 'accept')}>
                        <Check size={15} />
                      </div>
                    )}
                    {item.decline && (
                      <div className="gmini" style={{ color: 'var(--kid-pink)' }} title="Decline" onClick={() => !busy && answer(item, 'decline')}>
                        <UserX size={15} />
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          {loaded && !items.length && !error && <div className="stat-row">Nothing waiting for you.</div>}
        </div>
      </div>
    </div>
  );
}
