import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Shield, LayoutGrid, Users, CreditCard, Eye, Settings, Plus, Trash2, Check, X, Crown, AlertTriangle, Layers } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../hooks/useAuth';
import type { Stroke } from '../lib/engine';
import { renderStrokesToCanvas } from '../lib/strokeRenderer';

type AdminTab = 'overview' | 'users' | 'billing' | 'content' | 'plans';

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
  const [tab, setTab] = useState<AdminTab>('overview');
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

  const TABS: { key: AdminTab; label: string; Icon: LucideIcon }[] = [
    { key: 'overview', label: 'Overview', Icon: LayoutGrid },
    { key: 'users', label: 'Users', Icon: Users },
    { key: 'billing', label: 'Billing', Icon: CreditCard },
    { key: 'content', label: 'Groups & Battles', Icon: Eye },
    ...(superadmin ? [{ key: 'plans' as AdminTab, label: 'Plans', Icon: Settings }] : []),
  ];

  const stat = (label: string, value: any, tone: string) => (
    <div className="admin-stat">
      <span className={'admin-stat-dot ' + tone} />
      <span className="admin-stat-value">{value}</span>
      <span className="admin-stat-label">{label}</span>
    </div>
  );

  const inputStyle: React.CSSProperties = {
    fontSize: 12.5,
    padding: '9px 11px',
    borderRadius: 'var(--r-sm)',
    border: '1px solid var(--swatch-item-border)',
    background: 'var(--input-bg)',
    color: 'var(--text)',
    width: '100%',
    fontFamily: 'var(--font)',
    outline: 'none',
  };

  return (
    <div className="admin-shell">
      <div className="admin-wrap">
        {/* ── header ── */}
        <header className="admin-head">
          <button type="button" className="admin-back" onClick={onBack} title="Back to studio" aria-label="Back to studio">
            <ArrowLeft size={17} />
          </button>
          <span className="admin-mark">
            <Shield size={17} strokeWidth={2.1} />
          </span>
          <div className="admin-headtext">
            <h1 className="admin-title">Admin console</h1>
            <p className="admin-sub">{user?.email || ''}</p>
          </div>
          <span className={'admin-role' + (superadmin ? ' admin-role--super' : '')}>
            {superadmin ? <Crown size={12} /> : <Shield size={12} />}
            {superadmin ? 'Superadmin' : 'Admin'}
          </span>
        </header>

        {/* ── tabs ── */}
        <nav className="admin-tabs" role="tablist" aria-label="Admin sections">
          {TABS.map(({ key, label, Icon }) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={'admin-tab' + (tab === key ? ' is-active' : '')}
              onClick={() => setTab(key)}
            >
              <Icon size={14} strokeWidth={2} />
              {label}
            </button>
          ))}
        </nav>

        {error && (
          <div className="admin-error" role="alert">
            <AlertTriangle size={14} />
            <span>{error}</span>
          </div>
        )}

        {/* ── body ── */}
        <main className="admin-panel">
          {tab === 'overview' && (
            <>
              {!stats && <div className="admin-empty">Loading overview…</div>}
              {stats && (
                <>
                  <div className="admin-statgrid">
                    {stat('Users', stats.users, 'tone-a')}
                    {stat('Drawings', stats.drawings, 'tone-b')}
                    {stat('Groups', stats.groups, 'tone-c')}
                    {stat('Battles', stats.competitions, 'tone-a')}
                  </div>
                  <div className="admin-statgrid">
                    {stat('Subscribers', stats.subscribers, 'tone-b')}
                    {stat('Revenue', `₹${(stats.revenue / 100).toLocaleString()}`, 'tone-b')}
                    {stat('Payments', stats.payments, 'tone-a')}
                    {stat('Played', stats.competitionsPlayed, 'tone-c')}
                  </div>

                  {stats.newUsers?.length > 0 && (
                    <section className="admin-section">
                      <h2 className="admin-h2">New users</h2>
                      <div className="admin-list">
                        {stats.newUsers.map((u: any) => (
                          <div key={u.id} className="admin-row">
                            <span className="admin-row-main">{u.nickname || u.email}</span>
                            <span className="admin-row-meta">{new Date(u.createdAt).toLocaleDateString()}</span>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}
                </>
              )}
            </>
          )}

          {tab === 'users' && (
            <>
              {!users.length && <div className="admin-empty">Loading users…</div>}
              <div className="admin-list">
                {users.map((u) => (
                  <div key={u.id} className="admin-user">
                    <span className="admin-avatar">{(u.nickname || u.email || '?').charAt(0).toUpperCase()}</span>
                    <div className="admin-usertext">
                      <div className="admin-user-name">{u.nickname || u.email}</div>
                      <div className="admin-user-meta">
                        <span>{u.email}</span>
                        <span className="admin-tag">{u.drawingCount} drawings</span>
                        <span className="admin-tag">{u.subscribed ? `Pro · ${u.plan || 'monthly'}` : 'Free'}</span>
                        {u.role && u.role !== 'user' && (
                          <span className={'admin-tag ' + (u.role === 'superadmin' ? 'admin-tag--super' : 'admin-tag--admin')}>
                            {u.role}
                          </span>
                        )}
                        {u.suspended && <span className="admin-tag admin-tag--off">suspended</span>}
                      </div>
                    </div>

                    <div className="admin-user-actions">
                      <button type="button" className="admin-icon" title="View drawings" aria-label="View drawings" onClick={() => viewUser(u.id, u.nickname || u.email)}>
                        <Eye size={14} />
                      </button>
                      {superadmin && (
                        <select
                          className="admin-select"
                          value={u.role}
                          aria-label={`Role for ${u.email}`}
                          onChange={(e) => userAction(u.id, { role: e.target.value })}
                        >
                          <option value="user">user</option>
                          <option value="admin">admin</option>
                          <option value="superadmin">superadmin</option>
                        </select>
                      )}
                      <button
                        type="button"
                        className={'admin-pill' + (u.suspended ? ' admin-pill--ok' : ' admin-pill--warn')}
                        onClick={() => userAction(u.id, { suspended: !u.suspended })}
                      >
                        {u.suspended ? 'Reinstate' : 'Suspend'}
                      </button>
                      <button type="button" className="admin-pill admin-pill--danger" onClick={() => clearContent(u.id)}>
                        Clear content
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {tab === 'billing' && (
            <>
              {!billing.length && <div className="admin-empty">No payments yet.</div>}
              <div className="admin-list">
                {billing.map((p, i) => (
                  <div key={p.id + i} className="admin-row">
                    <div style={{ minWidth: 0 }}>
                      <div className="admin-row-main">{p.nickname || p.email}</div>
                      <div className="admin-row-sub">{p.plan || '—'} · {new Date(p.ts).toLocaleDateString()}</div>
                    </div>
                    <div className="admin-row-right">
                      <span className="admin-amount">₹{(p.amount / 100).toFixed(0)}</span>
                      {superadmin && p.userId && (
                        <button
                          type="button"
                          className="admin-icon admin-icon--danger"
                          title="Cancel subscription"
                          aria-label="Cancel subscription"
                          onClick={() => cancelSub(p.userId, p.nickname || p.email)}
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {tab === 'content' && (
            <>
              {!stats && <div className="admin-empty">Loading…</div>}
              {stats && (
                <>
                  <section className="admin-section">
                    <h2 className="admin-h2">
                      <Layers size={14} /> Groups
                    </h2>
                    <div className="admin-list">
                      {(stats.groupsList || []).map((g: any) => (
                        <div key={g.id} className="admin-row">
                          <span className="admin-row-main">{g.emoji} {g.name}</span>
                          <span className="admin-row-meta">{g.memberCount} members · {g.wins}W / {g.played}</span>
                          <button type="button" className="admin-icon admin-icon--danger" title="Delete group" aria-label={`Delete group ${g.name}`} onClick={() => delGroup(g.id, g.name)}>
                            <Trash2 size={13} />
                          </button>
                        </div>
                      ))}
                      {!(stats.groupsList || []).length && <div className="admin-empty">No groups yet.</div>}
                    </div>
                  </section>

                  <section className="admin-section">
                    <h2 className="admin-h2">Battles</h2>
                    <div className="admin-list">
                      {(stats.competitionsList || []).map((c: any) => (
                        <div key={c.id} className="admin-row">
                          <span className="admin-row-main">{c.prompt}</span>
                          <span className="admin-row-meta">{c.status} · {c.votes} votes</span>
                          <button type="button" className="admin-icon admin-icon--danger" title="Delete battle" aria-label="Delete battle" onClick={() => delCompetition(c.id)}>
                            <Trash2 size={13} />
                          </button>
                        </div>
                      ))}
                      {!(stats.competitionsList || []).length && <div className="admin-empty">No battles yet.</div>}
                    </div>
                  </section>
                </>
              )}
            </>
          )}

          {tab === 'plans' && superadmin && (
            <>
              <div className="admin-sectionhead">
                <div>
                  <h2 className="admin-h2">Plans &amp; features</h2>
                  <p className="admin-hint">Feature checkboxes gate the app live.</p>
                </div>
                <button type="button" className="admin-btn admin-btn--ghost" onClick={() => { setAdding((a) => !a); setError(''); }}>
                  <Plus size={14} /> {adding ? 'Close' : 'Add plan'}
                </button>
              </div>

              {adding && (
                <div className="admin-formcard">
                  <label className="admin-field">
                    <span>Plan label</span>
                    <input style={inputStyle} placeholder="e.g. Quarterly" value={newPlan.label} onChange={(e) => setNewPlan((n) => ({ ...n, label: e.target.value }))} />
                  </label>
                  <div className="admin-fieldrow">
                    <label className="admin-field">
                      <span>₹ price / period</span>
                      <input style={inputStyle} type="number" min={1} placeholder="₹ price" value={newPlan.amount} onChange={(e) => setNewPlan((n) => ({ ...n, amount: Number(e.target.value) }))} />
                    </label>
                    <label className="admin-field">
                      <span>Period</span>
                      <select style={inputStyle} value={newPlan.period} onChange={(e) => setNewPlan((n) => ({ ...n, period: e.target.value }))}>
                        {PERIODS.map((p) => <option key={p} value={p}>{p}</option>)}
                      </select>
                    </label>
                  </div>
                  <div className="admin-fieldrow">
                    <button type="button" className="admin-btn admin-btn--primary" onClick={createPlan} disabled={busy === 'new'}>
                      {busy === 'new' ? 'Creating…' : 'Create plan'}
                    </button>
                    <button type="button" className="admin-btn admin-btn--ghost" onClick={() => setAdding(false)}>Cancel</button>
                  </div>
                  <p className="admin-hint">
                    New plans start with all Pro features unlocked and unlimited drawings. Prices are in ₹/period.
                  </p>
                </div>
              )}

              <div className="admin-plans">
                {plans.map((plan) => {
                  const edit = editFor(plan);
                  const dirty = !!edits[plan.id];
                  return (
                    <section key={plan.id} className={'admin-plan' + (dirty ? ' is-dirty' : '')}>
                      <div className="admin-plan-head">
                        <div style={{ minWidth: 0 }}>
                          <div className="admin-plan-title">
                            <span className="admin-plan-namewrap">
                              <input
                                style={{ ...inputStyle, fontWeight: 700 }}
                              aria-label={`Label for plan ${plan.id}`}
                              value={edit.label}
                              onChange={(e) => setEdit(plan.id, 'label', e.target.value)}
                                disabled={plan.free}
                              />
                            </span>
                            {plan.free && <span className="admin-tag admin-tag--admin">Free</span>}
                            {dirty && <span className="admin-tag admin-tag--warn">Unsaved</span>}
                          </div>
                          <p className="admin-hint">
                            id: {plan.id}{plan.free ? ' · subscribers fall back here' : ''}
                          </p>
                        </div>
                        {!plan.free && (
                          <label className="admin-switch">
                            <input type="checkbox" checked={!!edit.active} onChange={(e) => setEdit(plan.id, 'active', e.target.checked)} />
                            <span>Active</span>
                          </label>
                        )}
                      </div>

                      <div className="admin-fieldrow">
                        <label className="admin-field">
                          <span>Price (₹ / period)</span>
                          <input style={inputStyle} type="number" min={1} aria-label={`Price for plan ${plan.id}`} value={edit.amount} onChange={(e) => setEdit(plan.id, 'amount', Number(e.target.value))} disabled={plan.free} />
                        </label>
                        <label className="admin-field">
                          <span>Period</span>
                          <select style={inputStyle} aria-label={`Period for plan ${plan.id}`} value={edit.period} onChange={(e) => setEdit(plan.id, 'period', e.target.value)} disabled={plan.free}>
                            {PERIODS.map((p) => <option key={p} value={p}>{p}</option>)}
                          </select>
                        </label>
                        <label className="admin-field">
                          <span>Gallery limit (−1 = ∞</span>
                          <input style={inputStyle} type="number" aria-label={`Gallery limit for plan ${plan.id}`} value={edit.galleryLimit} onChange={(e) => setEdit(plan.id, 'galleryLimit', Number(e.target.value))} />
                        </label>
                      </div>

                      <div className="admin-divider" />
                      <p className="admin-hint" style={{ marginBottom: 8 }}>Features — checked means unlocked on this plan</p>
                      <div className="admin-features">
                        {catalog.map((f) => {
                          const on = !!edit.features?.[f.key];
                          return (
                            <label key={f.key} className={'admin-chip' + (on ? ' is-on' : '')}>
                              <input type="checkbox" checked={on} onChange={() => toggleFeature(plan.id, f.key)} />
                              {f.label}
                            </label>
                          );
                        })}
                      </div>

                      <div className="admin-fieldrow admin-plan-actions">
                        <button type="button" className="admin-btn admin-btn--primary" onClick={() => savePlan(plan)} disabled={busy === plan.id}>
                          {busy === plan.id ? 'Saving…' : 'Save changes'}
                        </button>
                        {!plan.free && (
                          <button type="button" className="admin-btn admin-btn--danger" onClick={() => removePlan(plan)}>
                            Remove plan
                          </button>
                        )}
                      </div>
                    </section>
                  );
                })}
              </div>
            </>
          )}

          {userDetail && (
            <section className="admin-section">
              <div className="admin-sectionhead">
                <h2 className="admin-h2">Drawings by {userDetail.nickname}</h2>
                <button type="button" className="admin-icon" title="Close" aria-label="Close drawings" onClick={() => setUserDetail(null)}>
                  <X size={14} />
                </button>
              </div>
              <div className="admin-gallery">
                {Object.entries(userDetail.drawings).map(([name, strokes]) => (
                  <div key={name} className="admin-shot">
                    <MiniCanvas strokes={strokes || []} />
                    <span className="admin-shot-name">{name}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </main>

        <p className="admin-foot">
          <Check size={12} />
          Changes to plans apply to new sessions immediately; existing subscribers keep their entitlements until the period ends.
        </p>
      </div>
    </div>
  );
}
