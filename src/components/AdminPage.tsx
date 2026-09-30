import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Shield, LayoutGrid, Users, CreditCard, Eye, Settings, Plus, Trash2, Check, X } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../hooks/useAuth';
import type { Stroke } from '../lib/engine';
import { renderStrokesToCanvas } from '../lib/strokeRenderer';

interface Props {
  superadmin: boolean;
  onBack: () => void;
  onChanged?: () => void;
}

function MiniCanvas({ strokes }: { strokes: Stroke[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) renderStrokesToCanvas(ref.current, strokes || []);
  }, [strokes]);
  return <canvas ref={ref} width={140} height={105} style={{ width: 140, height: 105, borderRadius: 8, border: '1px solid var(--chip-border)', background: '#fff' }} />;
}

const PERIODS = ['monthly', 'yearly'];

export default function AdminPage({ superadmin, onBack, onChanged }: Props) {
  const api = useApi();
  const { user } = useAuth();
  const [tab, setTab] = useState<'overview' | 'users' | 'billing' | 'content' | 'plans'>('overview');
  const [stats, setStats] = useState<any>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [billing, setBilling] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [userDetail, setUserDetail] = useState<{ id: string; nickname: string; drawings: Record<string, Stroke[]> } | null>(null);

  const [plans, setPlans] = useState<any[]>([]);
  const [catalog, setCatalog] = useState<{ key: string; label: string }[]>([]);
  const [edits, setEdits] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newPlan, setNewPlan] = useState({ label: '', amount: 149, period: 'monthly' as string });

  const loadOverview = useCallback(async () => {
    try {
      setStats(await api.get('/api/admin'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load overview.');
    }
  }, [api]);

  const loadUsers = useCallback(async () => {
    try {
      const d = await api.get('/api/admin/users');
      setUsers(d.users || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load users.');
    }
  }, [api]);

  const loadBilling = useCallback(async () => {
    try {
      const d = await api.get('/api/admin/billing');
      setBilling(d.payments || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load billing.');
    }
  }, [api]);

  const loadPlans = useCallback(async () => {
    try {
      const d = await api.get('/api/admin/plans');
      setPlans(d.plans || []);
      setCatalog(d.catalog || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load plans.');
    }
  }, [api]);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);
  useEffect(() => {
    if (tab === 'users') loadUsers();
  }, [tab, loadUsers]);
  useEffect(() => {
    if (tab === 'billing') loadBilling();
  }, [tab, loadBilling]);
  useEffect(() => {
    if (tab === 'plans') {
      loadPlans();
      setEdits({});
    }
  }, [tab, loadPlans]);

  async function userAction(id: string, patch: Record<string, unknown>) {
    setError('');
    try {
      await api.patch(`/api/admin/users/${id}`, patch);
      await loadUsers();
      await loadOverview();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed.');
    }
  }

  async function viewUser(id: string, nickname: string) {
    try {
      const d = await api.get(`/api/admin/users/${id}`);
      setUserDetail({ id, nickname, drawings: d.drawings || {} });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load drawings.');
    }
  }

  async function clearContent(id: string) {
    if (!confirm('Delete this user’s drawings, history and favorites?')) return;
    try {
      await api.del(`/api/admin/users/${id}`);
      await loadOverview();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed.');
    }
  }

  async function cancelSub(userId: string, nickname: string) {
    if (!confirm(`Cancel ${nickname}'s subscription?`)) return;
    try {
      await api.post('/api/admin/billing', { userId });
      await loadBilling();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed.');
    }
  }

  async function delGroup(id: string, name: string) {
    if (!confirm(`Delete group "${name}" and its battles?`)) return;
    try {
      await api.del(`/api/admin/groups/${id}`);
      await loadOverview();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed.');
    }
  }

  async function delCompetition(id: string) {
    if (!confirm('Delete this competition?')) return;
    try {
      await api.del(`/api/admin/competitions/${id}`);
      await loadOverview();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed.');
    }
  }

  const editFor = (plan: any) => edits[plan.id] || {
    label: plan.label,
    amount: plan.amount,
    period: plan.period,
    active: !!plan.active,
    galleryLimit: plan.galleryLimit,
    features: { ...plan.features },
  };

  function setEdit(planId: string, field: string, value: any) {
    setEdits((prev) => ({
      ...prev,
      [planId]: { ...(prev[planId] || editFor(plans.find((p) => p.id === planId) || {})), [field]: value },
    }));
  }

  async function savePlan(plan: any) {
    const edit = edits[plan.id];
    if (!edit) return;
    setBusy(plan.id);
    setError('');
    try {
      await api.patch(`/api/admin/plans/${plan.id}`, {
        label: edit.label,
        amount: edit.amount,
        period: edit.period,
        active: edit.active,
        galleryLimit: edit.galleryLimit,
        features: edit.features,
      });
      setEdits((prev) => { const n = { ...prev }; delete n[plan.id]; return n; });
      await loadPlans();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed.');
    } finally {
      setBusy(null);
    }
  }

  async function removePlan(plan: any) {
    if (!confirm(`Remove plan "${plan.label}"? Users on this plan are protected.`)) return;
    setBusy(plan.id);
    setError('');
    try {
      await api.del(`/api/admin/plans/${plan.id}`);
      setEdits((prev) => { const n = { ...prev }; delete n[plan.id]; return n; });
      await loadPlans();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Remove failed.');
    } finally {
      setBusy(null);
    }
  }

  async function createPlan() {
    if (!newPlan.label.trim()) {
      setError('Enter a plan label.');
      return;
    }
    setBusy('new');
    setError('');
    try {
      await api.post('/api/admin/plans', newPlan);
      setAdding(false);
      setNewPlan({ label: '', amount: 149, period: 'monthly' });
      await loadPlans();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed.');
    } finally {
      setBusy(null);
    }
  }

  function toggleFeature(planId: string, key: string) {
    const edit = edits[planId];
    const base = edit || editFor(plans.find((p) => p.id === planId) || {});
    const features = { ...base.features, [key]: !base.features[key] };
    setEdits((prev) => ({ ...prev, [planId]: { ...base, features } }));
  }

  const card = (label: string, value: any, color = 'var(--accent)') => (
    <div style={{ flex: 1, borderRadius: 10, padding: '10px 8px', background: 'var(--panel-bg)', border: '1px solid var(--chip-border)', textAlign: 'center', minWidth: 70 }}>
      <div style={{ fontSize: 18, fontWeight: 800, color }}>{value}</div>
      <div style={{ fontSize: 9.5, color: 'var(--text-dim)' }}>{label}</div>
    </div>
  );

  const inputStyle: React.CSSProperties = {
    fontSize: 11.5,
    padding: '5px 8px',
    borderRadius: 8,
    border: '1px solid var(--chip-border)',
    background: 'var(--panel-bg)',
    color: 'var(--text)',
    width: '100%',
  };

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 80,
        background: 'linear-gradient(160deg, var(--bg) 0%, var(--bg2) 100%)',
        color: 'var(--text)',
        overflowY: 'auto',
        padding: 'max(14px, env(safe-area-inset-top)) 14px 30px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <div onClick={onBack} className="gmini" title="Back to studio"><ArrowLeft size={16} /></div>
          <div style={{ width: 32, height: 32, borderRadius: 9, background: 'var(--accent2)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Shield size={16} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 800, lineHeight: 1.2 }}>Admin / Super Admin</div>
            <div style={{ fontSize: 10.5, color: 'var(--text-dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {user?.email || ''}
            </div>
          </div>
        </div>
        <div style={{ fontSize: 10, fontWeight: 700, background: superadmin ? 'rgba(var(--clay-rgb),0.15)' : 'rgba(var(--kid-blue-rgb),0.15)', color: superadmin ? 'var(--kid-pink)' : 'var(--kid-blue)', padding: '4px 10px', borderRadius: 20, flexShrink: 0 }}>
          {superadmin ? 'SUPERADMIN' : 'ADMIN'}
        </div>
      </div>

      <div className="flex gap-1 flex-wrap mb-3">
        {(
          [
            ['overview', 'Overview', LayoutGrid],
            ['users', 'Users', Users],
            ['billing', 'Billing', CreditCard],
            ['content', 'Groups & Battles', Eye],
            ...(superadmin ? ([['plans', 'Plans', Settings]] as const) : []),
          ] as const
        ).map(([t, label, Icon]) => (
          <div key={t} className="gbtn" style={{ width: 'auto', padding: '7px 12px', color: tab === t ? 'var(--text)' : undefined, background: tab === t ? 'rgba(var(--kid-blue-rgb),0.15)' : undefined, borderColor: tab === t ? 'rgba(var(--kid-blue-rgb),0.4)' : undefined }} onClick={() => setTab(t)}>
            <Icon size={13} /> {label}
          </div>
        ))}
      </div>

      {error && <div style={{ fontSize: 11.5, color: 'var(--kid-pink)', marginBottom: 8 }}>{error}</div>}

      {tab === 'overview' && stats && (
        <>
          <div className="flex gap-1.5 mb-2 mt-1">
            {card('Users', stats.users, 'var(--kid-blue)')}
            {card('Drawings', stats.drawings, 'var(--kid-green)')}
            {card('Groups', stats.groups, 'var(--kid-yellow)')}
            {card('Battles', stats.competitions, 'var(--accent)')}
          </div>
          <div className="flex gap-1.5 mb-2">
            {card('Subscribers', stats.subscribers, 'var(--accent2)')}
            {card('Revenue', `₹${(stats.revenue / 100).toLocaleString()}`, 'var(--kid-green)')}
            {card('Payments', stats.payments, 'var(--kid-blue)')}
            {card('Played', stats.competitionsPlayed, 'var(--kid-pink)')}
          </div>
          {stats.newUsers?.length > 0 && (
            <div style={{ fontSize: 11.5, marginTop: 6 }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>New users</div>
              {stats.newUsers.map((u: any) => (
                <div key={u.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: 11 }}>
                  <span>{u.nickname || u.email}</span>
                  <span style={{ color: 'var(--text-dim)' }}>{new Date(u.createdAt).toLocaleDateString()}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {tab === 'users' && (
        <div style={{ maxHeight: '64vh', overflowY: 'auto' }}>
          {users.map((u) => (
            <div key={u.id} style={{ border: '1px solid var(--chip-border)', borderRadius: 10, padding: 8, marginBottom: 8, background: 'var(--panel-bg)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{u.nickname || u.email}</div>
                  <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                    {u.email} · {u.drawingCount} drawings · {u.subscribed ? `Pro (${u.plan || 'monthly'})` : 'Free'}
                    {u.suspended ? ' · ⛔ suspended' : ''}
                  </div>
                </div>
                <div className="flex gap-1.5 flex-shrink-0">
                  <div className="gmini" title="View drawings" onClick={() => viewUser(u.id, u.nickname || u.email)}><Eye size={14} /></div>
                  {superadmin && (
                    <select
                      value={u.role}
                      onChange={(e) => userAction(u.id, { role: e.target.value })}
                      style={{ fontSize: 10, padding: '2px 4px', borderRadius: 6, border: '1px solid var(--chip-border)', background: 'var(--panel-bg)', color: 'var(--text)' }}
                    >
                      <option value="user">user</option>
                      <option value="admin">admin</option>
                      <option value="superadmin">superadmin</option>
                    </select>
                  )}
                </div>
              </div>
              <div className="flex gap-1.5 mt-2">
                <div className="gbtn" style={{ flex: 1, justifyContent: 'center', color: u.suspended ? 'var(--kid-green)' : 'var(--kid-yellow)' }} onClick={() => userAction(u.id, { suspended: !u.suspended })}>
                  {u.suspended ? 'Reinstate' : 'Suspend'}
                </div>
                <div className="gbtn" style={{ flex: 1, justifyContent: 'center', color: 'var(--kid-pink)' }} onClick={() => clearContent(u.id)}>
                  Clear content
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'billing' && (
        <div style={{ maxHeight: '64vh', overflowY: 'auto' }}>
          {billing.map((p, i) => (
            <div key={p.id + i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--chip-border)', fontSize: 11.5 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.nickname || p.email}</div>
                <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>{p.plan || '—'} · {new Date(p.ts).toLocaleDateString()}</div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <span style={{ fontWeight: 700 }}>₹{(p.amount / 100).toFixed(0)}</span>
                {superadmin && p.userId && (
                  <div className="gmini" style={{ color: 'var(--kid-pink)' }} title="Cancel subscription" onClick={() => cancelSub(p.userId, p.nickname || p.email)}>
                    <Trash2 size={13} />
                  </div>
                )}
              </div>
            </div>
          ))}
          {!billing.length && <div className="stat-row">No payments yet.</div>}
        </div>
      )}

      {tab === 'content' && stats && (
        <div style={{ maxHeight: '64vh', overflowY: 'auto' }}>
          <div style={{ fontSize: 11, fontWeight: 700, margin: '4px 0' }}>Groups</div>
          {(stats.groupsList || []).map((g: any) => (
            <div key={g.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '5px 0', fontSize: 11.5 }}>
              <span>{g.emoji} {g.name} · {g.memberCount} members · {g.wins}W/{g.played}</span>
              <div className="gmini" style={{ color: 'var(--kid-pink)' }} title="Delete" onClick={() => delGroup(g.id, g.name)}><Trash2 size={13} /></div>
            </div>
          ))}
          <div style={{ fontSize: 11, fontWeight: 700, margin: '8px 0 4px' }}>Battles</div>
          {(stats.competitionsList || []).map((c: any) => (
            <div key={c.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '5px 0', fontSize: 11.5 }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '78%' }}>{c.prompt} · {c.status} · {c.votes} votes</span>
              <div className="gmini" style={{ color: 'var(--kid-pink)' }} title="Delete" onClick={() => delCompetition(c.id)}><Trash2 size={13} /></div>
            </div>
          ))}
        </div>
      )}

      {tab === 'plans' && superadmin && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700 }}>
              Plans &amp; features <span style={{ color: 'var(--text-dim)', fontWeight: 500 }}>(features gate the app live)</span>
            </div>
            <div className="gmini" title="Add plan" onClick={() => { setAdding((a) => !a); setError(''); }}>
              <Plus size={15} />
            </div>
          </div>

          {adding && (
            <div style={{ border: '1.5px solid var(--accent)', borderRadius: 12, padding: 10, marginBottom: 10, display: 'flex', flexDirection: 'column', gap: 8, background: 'var(--panel-bg)' }}>
              <input style={inputStyle} placeholder="Plan label (e.g. Quarterly)" value={newPlan.label} onChange={(e) => setNewPlan((n) => ({ ...n, label: e.target.value }))} />
              <div className="flex gap-2">
                <input style={{ ...inputStyle, width: '45%' }} type="number" min={1} placeholder="₹ price/month basis" value={newPlan.amount} onChange={(e) => setNewPlan((n) => ({ ...n, amount: Number(e.target.value) }))} />
                <select style={{ ...inputStyle, width: 'auto' }} value={newPlan.period} onChange={(e) => setNewPlan((n) => ({ ...n, period: e.target.value }))}>
                  {PERIODS.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div className="flex gap-2">
                <div className="gbtn" style={{ flex: 1, justifyContent: 'center', background: 'var(--accent)', color: '#fff' }} onClick={createPlan}>
                  {busy === 'new' ? 'Creating…' : 'Create plan'}
                </div>
                <div className="gbtn" style={{ flex: 1, justifyContent: 'center' }} onClick={() => setAdding(false)}>Cancel</div>
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>New plans start with all Pro features unlocked and unlimited drawings. Prices are in ₹/period (monthly or yearly).</div>
            </div>
          )}

          {plans.map((plan) => {
            const edit = editFor(plan);
            return (
              <div key={plan.id} style={{ border: '1px solid var(--chip-border)', borderRadius: 12, padding: 10, marginBottom: 10, background: 'var(--panel-bg)' }}>
                <div className="flex gap-2 items-center justify-between">
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <input style={{ ...inputStyle, width: 110, fontWeight: 700 }} value={edit.label} onChange={(e) => setEdit(plan.id, 'label', e.target.value)} disabled={plan.free} />
                      {plan.free && <span style={{ fontSize: 9, background: 'rgba(var(--kid-green-rgb),0.15)', color: 'var(--kid-green)', padding: '2px 7px', borderRadius: 10, fontWeight: 700 }}>FREE</span>}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>id: {plan.id}{plan.free ? ' · subscribers fall back here' : ''}</div>
                  </div>
                  {!plan.free && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, cursor: 'pointer' }}>
                      <input type="checkbox" checked={!!edit.active} onChange={(e) => setEdit(plan.id, 'active', e.target.checked)} />
                      Active
                    </label>
                  )}
                </div>

                <div className="flex gap-2 mt-2">
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 9.5, color: 'var(--text-dim)', marginBottom: 3 }}>Price (₹ / period)</div>
                    <input style={inputStyle} type="number" min={1} value={edit.amount} onChange={(e) => setEdit(plan.id, 'amount', Number(e.target.value))} disabled={plan.free} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 9.5, color: 'var(--text-dim)', marginBottom: 3 }}>Period</div>
                    <select style={inputStyle} value={edit.period} onChange={(e) => setEdit(plan.id, 'period', e.target.value)} disabled={plan.free}>
                      {PERIODS.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 9.5, color: 'var(--text-dim)', marginBottom: 3 }}>Gallery limit (−1 = ∞)</div>
                    <input style={inputStyle} type="number" value={edit.galleryLimit} onChange={(e) => setEdit(plan.id, 'galleryLimit', Number(e.target.value))} />
                  </div>
                </div>

                <div style={{ margin: '8px 0', borderTop: '1px solid var(--chip-border)' }} />
                <div style={{ fontSize: 9.5, color: 'var(--text-dim)', marginBottom: 5 }}>Features (checked = unlocked on this plan)</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {catalog.map((f) => (
                    <label key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5, cursor: 'pointer' }}>
                      <input type="checkbox" checked={!!edit.features?.[f.key]} onChange={() => toggleFeature(plan.id, f.key)} />
                      <span>{f.label}</span>
                    </label>
                  ))}
                </div>

                <div className="flex gap-2 mt-3">
                  <div className="gbtn" style={{ flex: 1, justifyContent: 'center', background: 'var(--accent)', color: '#fff' }} onClick={() => savePlan(plan)}>
                    {busy === plan.id ? 'Saving…' : 'Save changes'}
                  </div>
                  {!plan.free && (
                    <div className="gbtn" style={{ flex: 1, justifyContent: 'center', color: 'var(--kid-pink)' }} onClick={() => removePlan(plan)}>
                      Remove plan
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {userDetail && (
        <div style={{ marginTop: 10, border: '1px solid var(--chip-border)', borderRadius: 12, padding: 10, background: 'var(--panel-bg)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 700 }}>Drawings by {userDetail.nickname}</span>
            <div className="gmini" onClick={() => setUserDetail(null)}><X size={13} /></div>
          </div>
          <div className="flex gap-2 flex-wrap" style={{ maxHeight: 240, overflowY: 'auto' }}>
            {Object.entries(userDetail.drawings).map(([name, strokes]) => (
              <div key={name} style={{ textAlign: 'center' }}>
                <MiniCanvas strokes={strokes || []} />
                <div style={{ fontSize: 9.5, color: 'var(--text-dim)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: 'var(--text-dim)', marginTop: 14 }}>
        <Check size={12} /> Changes to plans apply to new sessions immediately; existing subscribers keep their entitlements until the period ends.
      </div>
    </div>
  );
}