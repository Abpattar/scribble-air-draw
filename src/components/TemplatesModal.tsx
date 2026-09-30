import { useState } from 'react';
import { X, Lock } from 'lucide-react';
import { templateCategories, templatesByCategory, type Template } from '../lib/templates';
import SubscriptionModal from './SubscriptionModal';

interface Props {
  onClose: () => void;
  subscribed: boolean;
  plan: string | null;
  subscribedUntil: number | null;
  payments: any[];
  templatesAllowed: boolean;
  onSubscribe: () => Promise<void> | void;
  onCancel: () => Promise<void> | void;
  onPick: (tpl: Template) => Promise<void>;
}

export default function TemplatesModal({ onClose, subscribed, plan, subscribedUntil, payments, templatesAllowed, onSubscribe, onCancel, onPick }: Props) {
  const [activeCat, setActiveCat] = useState(templateCategories[0] || '');
  const [loadingUrl, setLoadingUrl] = useState<string | null>(null);
  const [showPay, setShowPay] = useState(false);

  const items = templatesByCategory[activeCat] || [];
  const locked = !templatesAllowed;

  async function handlePick(tpl: Template) {
    if (locked && !tpl.free) {
      setShowPay(true);
      return;
    }
    setLoadingUrl(tpl.url);
    try {
      await onPick(tpl);
      onClose();
    } finally {
      setLoadingUrl(null);
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal-box" style={{ width: 340 }}>
        <div className="close-btn" onClick={onClose} title="Close"><X size={16} /></div>
        <h3>Trace Templates</h3>

        {!templateCategories.length ? (
          <div className="stat-row">No templates found yet — drop images into Subscription/&lt;Category&gt;/.</div>
        ) : (
          <>
            <div className="flex gap-1.5 flex-wrap mb-3">
              {templateCategories.map((cat) => (
                <div
                  key={cat}
                  onClick={() => setActiveCat(cat)}
                  className="gbtn"
                  style={{
                    width: 'auto',
                    padding: '6px 12px',
                    cursor: 'pointer',
                    background: cat === activeCat ? 'rgba(var(--kid-blue-rgb),0.18)' : undefined,
                    color: cat === activeCat ? 'var(--text)' : undefined,
                    borderColor: cat === activeCat ? 'rgba(var(--kid-blue-rgb),0.5)' : undefined,
                  }}
                >
                  {cat}
                </div>
              ))}
            </div>

            <div className="grid grid-cols-3 gap-2 mb-2">
              {items.map((tpl) => (
                <div
                  key={tpl.url}
                  onClick={() => handlePick(tpl)}
                  className="relative rounded-lg overflow-hidden border border-[rgba(var(--forest-rgb),0.12)] cursor-pointer bg-white aspect-square"
                >
                  <img
                    src={tpl.url}
                    alt={tpl.name}
                    className="w-full h-full object-cover"
                    style={{ filter: locked || tpl.free ? 'none' : 'blur(3px) brightness(0.85)' }}
                  />
                  {locked && !tpl.free && (
                    <div className="absolute inset-0 flex items-center justify-center text-[var(--forest)]/60">
                      <Lock size={22} />
                    </div>
                  )}
                  {tpl.free && locked && (
                    <div className="absolute top-1 left-1 text-[8px] px-1.5 py-0.5 rounded bg-[var(--kid-green)] text-white font-semibold">
                      FREE
                    </div>
                  )}
                  {loadingUrl === tpl.url && (
                    <div className="absolute inset-0 flex items-center justify-center bg-white/70 text-[10px] text-[var(--forest)]">
                      Loading…
                    </div>
                  )}
                  <div className="absolute bottom-0 inset-x-0 text-[9px] text-center py-0.5 bg-white/85 text-[var(--forest)]/75 truncate px-1">
                    {tpl.name}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {locked && (
          <div className="mt-3 p-3 rounded-xl border border-[rgba(var(--kid-blue-rgb),0.4)] bg-[rgba(var(--kid-blue-rgb),0.08)] text-center">
            <div className="text-[12.5px] text-[var(--forest)] mb-1 font-semibold">Unlock the trace library</div>
            <div className="text-[11px] text-[var(--forest)]/55 mb-2.5 leading-relaxed">
              Subscribers get every outline template, loaded as a background you draw over.
            </div>
            <button className="auth-submit" onClick={() => setShowPay(true)}>
              Subscribe to unlock
            </button>
          </div>
        )}

        {/* A subscriber also gets quick access to manage their plan. */}
        {subscribed && !locked && (
          <div className="mt-3 text-center">
            <button className="gbtn" style={{ width: '100%', justifyContent: 'center' }} onClick={() => setShowPay(true)}>
              Pro active — manage plan
            </button>
          </div>
        )}
      </div>

      {showPay && (
        <SubscriptionModal
          subscribed={subscribed}
          plan={plan}
          subscribedUntil={subscribedUntil}
          payments={payments}
          onClose={() => setShowPay(false)}
          onSubscribed={onSubscribe}
          onCancel={onCancel}
        />
      )}
    </div>
  );
}