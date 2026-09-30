import { useEffect, useState } from 'react';
import { X, Check, Zap, Sparkles } from 'lucide-react';
import { useSession } from '@clerk/clerk-react';
import { useApi } from '../hooks/useApi';
import { DEFAULT_PLAN_PAYLOAD, FEATURE_CATALOG, type FeatureDef } from '../lib/plans';

interface Plan {
  id: string;
  label: string;
  amount: number;
  price: number;
  period: string;
  features: Record<string, boolean>;
  galleryLimit: number;
  description: string;
}

interface Props {
  subscribed: boolean;
  plan: string | null;
  subscribedUntil: number | null;
  payments: any[];
  reason?: string;
  onClose: () => void;
  onSubscribed: () => Promise<void> | void;
  onCancel: () => Promise<void> | void;
}

const CHECKOUT_SCRIPT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';
const CHECKOUT_SCRIPT_ID = 'razorpay-checkout-script';

function loadCheckout() {
  return new Promise<boolean>((resolve) => {
    if (typeof window === 'undefined') return resolve(false);
    const existing = document.getElementById(CHECKOUT_SCRIPT_ID) as HTMLScriptElement | null;
    if (existing) {
      if ((window as any).Razorpay) return resolve(true);
      existing.addEventListener('load', () => resolve(Boolean((window as any).Razorpay)), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.id = CHECKOUT_SCRIPT_ID;
    script.src = CHECKOUT_SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve(Boolean((window as any).Razorpay));
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

export default function SubscriptionModal({
  subscribed,
  plan,
  subscribedUntil,
  payments,
  reason,
  onClose,
  onSubscribed,
  onCancel,
}: Props) {
  const api = useApi();
  const { session } = useSession();
  // Seeded defaults render instantly and persist if /api/plans is unreachable.
  const [plans, setPlans] = useState<Plan[]>(DEFAULT_PLAN_PAYLOAD.plans);
  const [catalog, setCatalog] = useState<FeatureDef[]>(FEATURE_CATALOG);
  const [usingDefaults, setUsingDefaults] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [step, setStep] = useState<'choose' | 'success'>('choose');
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/api/plans')
      .then((d) => {
        if ((d.plans || []).length) setPlans(d.plans);
        if ((d.catalog || []).length) setCatalog(d.catalog);
        setUsingDefaults(false);
      })
      .catch(() => setUsingDefaults(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startCheckout(pl: Plan) {
    setError('');
    setBusyId(pl.id);
    try {
      const ord = await api.post('/api/create-order', { planId: pl.id });
      if (!ord.orderId || !ord.keyId) {
        throw new Error(ord.error || 'Payment server returned an invalid response.');
      }
      const loaded = await loadCheckout();
      if (!loaded || !(window as any).Razorpay) throw new Error('Razorpay checkout script failed to load');

      const handler = async (res: any) => {
        try {
          const idToken = await session?.getToken();
          const v = await api.post('/api/verify-payment', { ...res, idToken });
          if (!v.verified) throw new Error(v.error || 'Payment verification failed');
          await onSubscribed();
          setStep('success');
          window.setTimeout(onClose, 1400);
        } catch (err) {
          console.error('payment verification failed', err);
          setError(err instanceof Error ? err.message : 'Verification failed');
          setBusyId(null);
        }
      };

      const email = session?.user?.emailAddresses?.[0]?.emailAddress || '';
      const name = session?.user?.fullName || session?.user?.username || '';
      const r = new (window as any).Razorpay({
        key: ord.keyId,
        order_id: ord.orderId,
        amount: ord.amount,
        currency: ord.currency || 'INR',
        name: 'Neon Air Draw',
        description: pl.description,
        prefill: { email, name },
        handler,
        theme: { color: 'var(--emerald)' },
        modal: { ondismiss: () => setBusyId(null) },
      });
      r.open();
    } catch (err) {
      console.error('checkout failed', err);
      setError(err instanceof Error ? err.message : 'Unable to start Razorpay Checkout.');
      setBusyId(null);
    }
  }

  async function handleCancel() {
    if (!confirm('Cancel your subscription? One-time payments don\'t auto-renew — cancelling ends your Pro access now.')) return;
    setBusyId('cancel');
    try {
      const res = await api.post('/api/cancel-subscription');
      await onCancel();
      alert(res?.message || 'Subscription cancelled.');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not cancel right now.');
    } finally {
      setBusyId(null);
    }
  }

  const activePlan = plans.find((p) => p.id === plan);
  const activeLabel = subscribed ? (activePlan?.label || (plan === 'yearly' ? 'Yearly' : 'Monthly')) : null;
  const fmtDate = subscribedUntil ? new Date(subscribedUntil).toLocaleDateString() : null;

  return (
    <div className="modal-overlay" style={{ zIndex: 90 }} onClick={onClose}>
      <div className="modal-box" style={{ width: 360, maxWidth: '92vw' }} onClick={(e) => e.stopPropagation()}>
        <div className="close-btn" onClick={onClose} title="Close"><X size={16} /></div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <div style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--kid-blue)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Zap size={16} />
          </div>
          <h3 style={{ margin: 0 }}>My Plan</h3>
        </div>

        {reason && (
          <div className="stat-row" style={{ marginTop: 10, background: 'var(--chip-bg)', border: '1px solid var(--kid-pink)' }}>
            <Sparkles size={14} /> {reason}
          </div>
        )}
        {usingDefaults && (
          <div className="stat-row" style={{ marginTop: 8, fontSize: 10.5, color: 'var(--text-dim)' }}>
            Showing standard plans — couldn't reach the plan server.
          </div>
        )}

        {subscribed ? (
          <>
            <div className="stat-row" style={{ marginTop: 10 }}>
              Pro active · {activeLabel} plan
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 10 }}>
              Renews/expires: <b>{fmtDate || '—'}</b>
            </div>
            {payments.length > 0 && (
              <div style={{ fontSize: 11.5, color: 'var(--text)', margin: '10px 0' }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>Payment history</div>
                {payments
                  .slice()
                  .reverse()
                  .map((p, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid var(--chip-border)' }}>
                      <span>₹{((p.amount || 0) / 100).toFixed(0)} · {p.plan}</span>
                      <span style={{ color: 'var(--text-dim)' }}>{new Date(p.ts).toLocaleDateString()}</span>
                    </div>
                  ))}
              </div>
            )}
            <button className="gbtn" style={{ width: '100%', marginTop: 8, color: 'var(--kid-pink)' }} onClick={handleCancel} disabled={busyId === 'cancel'}>
              {busyId === 'cancel' ? 'Cancelling…' : 'Cancel subscription'}
            </button>
          </>
        ) : (
          <div className="grid grid-cols-2 gap-2 my-3">
            {plans.map((pl) => (
              <div
                key={pl.id}
                style={{
                  border: busyId === pl.id ? '1.5px solid var(--accent)' : '1.5px solid var(--chip-border)',
                  borderRadius: 12,
                  padding: '12px 10px',
                  cursor: 'pointer',
                  background: 'var(--panel-bg)',
                }}
                onClick={() => startCheckout(pl)}
              >
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--accent)' }}>₹{pl.amount}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>per {pl.id === 'monthly' ? 'month' : 'year'}</div>
                  <div style={{ fontSize: 11.5, fontWeight: 600, marginTop: 4 }}>{pl.label}</div>
                </div>
                <div style={{ margin: '8px 0', borderTop: '1px solid var(--chip-border)' }} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minHeight: catalog.length * 15 }}>
                  {catalog.map((f) => (
                    <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10.5, color: pl.features?.[f.key] ? 'var(--text)' : 'var(--text-dim)', opacity: pl.features?.[f.key] ? 1 : 0.55 }}>
                      <Check size={11} style={{ color: pl.features?.[f.key] ? 'var(--kid-green)' : 'var(--text-dim)' }} />
                      <span style={{ textDecoration: pl.features?.[f.key] ? 'none' : 'line-through' }}>{f.label}</span>
                    </div>
                  ))}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10.5, color: pl.galleryLimit === -1 ? 'var(--text)' : 'var(--text-dim)' }}>
                    <Check size={11} style={{ color: pl.galleryLimit === -1 ? 'var(--kid-green)' : 'var(--text-dim)' }} />
                    {pl.galleryLimit === -1 ? 'Unlimited drawings' : `${pl.galleryLimit} drawings max`}
                  </div>
                </div>
                <div className="gbtn" style={{ marginTop: 8, background: busyId === pl.id ? 'var(--kid-blue)' : 'var(--accent)', color: '#fff', justifyContent: 'center' }}>
                  {busyId === pl.id ? 'Opening…' : 'Subscribe'}
                </div>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: 'var(--kid-green)', marginTop: 6 }}>
          <Check size={12} /> One-time payment · No auto-renewal · Receipts in-app · Razorpay (₹)
        </div>

        {error && <div style={{ fontSize: 11.5, color: 'var(--kid-pink)', marginTop: 8 }}>{error}</div>}

        {step === 'success' && (
          <div className="stat-row" style={{ marginTop: 8 }}>Payment successful — Pro unlocked!</div>
        )}
      </div>
    </div>
  );
}