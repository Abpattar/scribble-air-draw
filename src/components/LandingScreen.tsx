import { motion } from 'framer-motion';
import {
  Camera,
  Hand,
  Cloud,
  Sticker,
  Play,
  History,
  Palette,
  Download,
  Layers,
  Check,
  Minus,
  ArrowRight,
  Sparkles,
} from 'lucide-react';
import { DEFAULT_FREE_PLAN, DEFAULT_PLAN_PAYLOAD, FEATURE_CATALOG, galleryLabel } from '../lib/plans';

interface Props {
  onGetStarted: () => void;
}

/* The flow below mirrors what the studio actually does, in order. */
const FLOW = [
  {
    Icon: Camera,
    title: 'Your camera becomes the canvas',
    text: 'Point your webcam at yourself and the live feed fills the whole screen. That is your drawing surface — nothing to load, nothing to import.',
  },
  {
    Icon: Hand,
    title: 'Hand tracking finds your fingertip',
    text: 'The camera watches one finger. Wherever it points, the brush lands — so a wave of your hand becomes a line of ink.',
  },
  {
    Icon: Sparkles,
    title: 'Gestures switch modes as you go',
    text: 'Point to draw, raise two fingers to move the picture, open your palm to fill a shape. No clicking, no menus in the way.',
  },
];

const FEATURES = [
  { Icon: Hand, title: 'Draw in the air', text: 'Pen, line, circle, rectangle, fill and eraser — all driven by your hand, right in front of the webcam.' },
  { Icon: Sticker, title: 'Trace a template', text: 'Pick an outline, trace over it in the air and colour it in. The drawing is yours from the first stroke.' },
  { Icon: Cloud, title: 'Saved to your account', text: 'Every drawing is written to your profile as you go. Sign in on any device and your gallery is where you left it.' },
  { Icon: History, title: 'Version history', text: 'Checkpoints are kept while you work, so an earlier version is always one tap away.' },
  { Icon: Play, title: 'Replay and record', text: 'Watch your strokes redraw themselves, or record the whole session as a video.' },
  { Icon: Download, title: 'Export how you like', text: 'Save a PNG of just your lines on a transparent background, or of the whole canvas.' },
];

const fadeUp = { initial: { opacity: 0, y: 18 }, whileInView: { opacity: 1, y: 0 }, viewport: { once: true, margin: '-80px' } };

/** A calm, static illustration of the studio surface — no fake data, no live canvas. */
function StageVisual() {
  return (
    <div className="lp-stage">
      <div className="lp-stage-frame">
        <div className="lp-stage-grid" />
        <svg className="lp-stage-stroke" viewBox="0 0 400 300" fill="none" aria-hidden="true">
          <path
            d="M78 214c30-18 46-52 62-84s34-54 62-46 40 40 62 52 44 8 58-10"
            stroke="#246a56"
            strokeWidth="6"
            strokeLinecap="round"
          />
          <path
            d="M96 246c40-14 86-22 132-18s76 10 100 2"
            stroke="#e29054"
            strokeWidth="5"
            strokeLinecap="round"
          />
          <path
            d="M132 92c22-14 48-16 68-6"
            stroke="#3a967a"
            strokeWidth="4"
            strokeLinecap="round"
          />
        </svg>
        <div className="lp-cursor" style={{ left: '62%', top: '47%' }} />

        <div className="lp-stage-badge">
          <span className="lp-stage-dot" />
          Drawing
        </div>
        <div className="lp-stage-hud lp-stage-hud--top">Point with one finger to draw</div>
        <div className="lp-stage-hud lp-stage-hud--tool">
          <span className="lp-stage-chip lp-stage-chip--on" />
          <Palette size={14} />
        </div>
        <div className="lp-stage-hud lp-stage-hud--color">
          <span className="lp-stage-chip" style={{ background: '#3a967a' }} />
        </div>
      </div>
    </div>
  );
}

export default function LandingScreen({ onGetStarted }: Props) {
  return (
    <div className="lp-shell">
      {/* ── nav ── */}
      <header className="lp-nav">
        <div className="lp-brand">
          <span className="lp-mark">
            <Hand size={17} strokeWidth={2.2} />
          </span>
          Scribble Air Draw
        </div>
        <button type="button" className="lp-btn lp-btn-primary lp-btn-sm" onClick={onGetStarted}>
          Get Started
          <ArrowRight size={15} />
        </button>
      </header>

      {/* ── hero ── */}
      <section className="lp-wrap" style={{ paddingTop: 72, paddingBottom: 40 }}>
        <div style={{ display: 'grid', gap: 56, alignItems: 'center', gridTemplateColumns: 'repeat(auto-fit, minmax(min(330px, 100%), 1fr))' }}>
          <motion.div initial={{ opacity: 0, y: 22 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}>
            <span className="lp-eyebrow">Air drawing with your webcam</span>
            <h1 className="lp-h1" style={{ marginTop: 18 }}>
              Draw with your hands.
              <br />
              <span className="lp-accent">Nothing else.</span>
            </h1>
            <p className="lp-lead" style={{ marginTop: 22, maxWidth: '30rem' }}>
              Your webcam is the canvas and your fingertip is the brush. Wave your hand and the
              lines appear — no mouse, no stylus, no mess to clean up.
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 34 }}>
              <button type="button" className="lp-btn lp-btn-primary" onClick={onGetStarted}>
                Get Started
                <ArrowRight size={16} />
              </button>
              <a className="lp-btn lp-btn-ghost" href="#how">
                See how it works
              </a>
            </div>
            <p className="lp-muted" style={{ marginTop: 20 }}>
              Free to start. Works on any laptop with a webcam.
            </p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 26 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.12, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          >
            <StageVisual />
          </motion.div>
        </div>
      </section>

      {/* ── how it works ── */}
      <section className="lp-wrap lp-section" id="how">
        <div style={{ display: 'grid', gap: 52, gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))', alignItems: 'start' }}>
          <div>
            <motion.span className="lp-eyebrow" {...fadeUp} transition={{ duration: 0.45 }}>
              Camera → Hand → Draw
            </motion.span>
            <motion.h2 className="lp-h2" style={{ marginTop: 16 }} {...fadeUp} transition={{ duration: 0.5 }}>
              Three steps, and you are already drawing.
            </motion.h2>
            <motion.p className="lp-body" style={{ marginTop: 16, maxWidth: '26rem' }} {...fadeUp} transition={{ delay: 0.06, duration: 0.5 }}>
              Nothing to install and no tutorial to sit through. Grant camera access, hold your
              hand up, and the studio takes over from there.
            </motion.p>
          </div>

          <div className="lp-flow">
            {FLOW.map((f, i) => (
              <motion.div
                key={f.title}
                className="lp-flow-step"
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-60px' }}
                transition={{ delay: i * 0.08, duration: 0.45 }}
              >
                <span className="lp-flow-num">
                  <f.Icon size={18} strokeWidth={2} />
                </span>
                <div>
                  <div className="lp-h3">{f.title}</div>
                  <p className="lp-body" style={{ marginTop: 6 }}>
                    {f.text}
                  </p>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ── features ── */}
      <section className="lp-wrap lp-section" id="features">
        <div style={{ maxWidth: '38rem' }}>
          <motion.span className="lp-eyebrow" {...fadeUp} transition={{ duration: 0.45 }}>
            Everything in the studio
          </motion.span>
          <motion.h2 className="lp-h2" style={{ marginTop: 16 }} {...fadeUp} transition={{ duration: 0.5 }}>
            A full drawing desk, minus the desk.
          </motion.h2>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))', columnGap: 56, marginTop: 34 }}>
          <div>
            {FEATURES.slice(0, 3).map((f) => (
              <motion.div key={f.title} className="lp-feature" {...fadeUp} transition={{ duration: 0.45 }}>
                <span className="lp-feature-icon">
                  <f.Icon size={19} strokeWidth={2} />
                </span>
                <div>
                  <div className="lp-h3">{f.title}</div>
                  <p className="lp-body" style={{ marginTop: 5 }}>
                    {f.text}
                  </p>
                </div>
              </motion.div>
            ))}
          </div>
          <div>
            {FEATURES.slice(3).map((f) => (
              <motion.div key={f.title} className="lp-feature" {...fadeUp} transition={{ duration: 0.45 }}>
                <span className="lp-feature-icon">
                  <f.Icon size={19} strokeWidth={2} />
                </span>
                <div>
                  <div className="lp-h3">{f.title}</div>
                  <p className="lp-body" style={{ marginTop: 5 }}>
                    {f.text}
                  </p>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ── product experience ── */}
      <section className="lp-wrap lp-section">
        <motion.div
          className="lp-band"
          initial={{ opacity: 0, y: 26 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.55 }}
          style={{ textAlign: 'left' }}
        >
          <div style={{ display: 'grid', gap: 44, gridTemplateColumns: 'repeat(auto-fit, minmax(min(290px, 100%), 1fr))', alignItems: 'center' }}>
            <div>
              <span className="lp-eyebrow" style={{ color: '#f0d8c0' }}>
                The studio
              </span>
              <h2 className="lp-h2" style={{ marginTop: 16, fontSize: 'clamp(1.7rem, 3.2vw, 2.4rem)' }}>
                The camera feed is the page.
              </h2>
              <p style={{ marginTop: 16, fontSize: '1rem', lineHeight: 1.7, color: 'rgba(241,238,232,0.76)' }}>
                You are never looking at a small preview in the corner. The live camera fills the
                whole screen and your drawing lands on top of it, so what you are looking at is
                what you are drawing on. The tools float above the edge of the frame and stay out
                of the way of your hands.
              </p>
            </div>
            <div style={{ display: 'grid', gap: 14 }}>
              {[
                { Icon: Layers, title: 'Your own background', text: 'Swap the camera for a blank white canvas, or import an image to draw over.' },
                { Icon: Cloud, title: 'Nothing is lost', text: 'Strokes are stored as you draw them, not when you press save.' },
                { Icon: History, title: 'Back out of mistakes', text: 'Undo a single stroke, clear the page, or return to an earlier checkpoint.' },
              ].map((f) => (
                <div key={f.title} className="auth-fact" style={{ color: 'rgba(241,238,232,0.8)' }}>
                  <span
                    className="auth-fact-icon"
                    style={{ color: '#f0d8c0', background: 'rgba(240,216,192,0.14)', borderColor: 'rgba(240,216,192,0.22)' }}
                  >
                    <f.Icon size={15} strokeWidth={2} />
                  </span>
                  <div>
                    <span style={{ color: '#f6f4ef', fontWeight: 600 }}>{f.title}. </span>
                    {f.text}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </motion.div>
      </section>

      {/* ── plans ── */}
      <section className="lp-wrap lp-section" id="plans">
        <div style={{ maxWidth: '36rem', margin: '0 auto', textAlign: 'center' }}>
          <motion.span className="lp-eyebrow" {...fadeUp} transition={{ duration: 0.45 }}>
            Simple plans
          </motion.span>
          <motion.h2 className="lp-h2" style={{ marginTop: 16 }} {...fadeUp} transition={{ duration: 0.5 }}>
            Start free. Upgrade only if you want more.
          </motion.h2>
          <motion.p className="lp-body" style={{ marginTop: 14 }} {...fadeUp} transition={{ delay: 0.06, duration: 0.5 }}>
            Drawing in the air is always free. Pro adds templates, background images, transparent
            export, replay and recording.
          </motion.p>
        </div>

        <div
          style={{
            display: 'grid',
            gap: 18,
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(268px, 100%), 1fr))',
            alignItems: 'stretch',
            marginTop: 40,
          }}
        >
          {[DEFAULT_FREE_PLAN, ...DEFAULT_PLAN_PAYLOAD.plans].map((plan, i) => {
            // one dark card only — it anchors the section without turning the
            // page green, and it is the plan we actually want people to take
            const featured = plan.id === 'yearly';
            return (
              <motion.div
                key={plan.id}
                className={'lp-plan' + (featured ? ' lp-plan--pro' : '')}
                initial={{ opacity: 0, y: 22 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-60px' }}
                transition={{ delay: i * 0.08, duration: 0.45 }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                  <span className="lp-plan-name">{plan.label}</span>
                  {plan.free ? (
                    <span className="lp-plan-tag">FREE</span>
                  ) : (
                    featured && <span className="lp-plan-tag">BEST VALUE</span>
                  )}
                </div>

                <div className="lp-plan-price">
                  ₹{plan.amount}
                  <small>/ {plan.id === 'monthly' ? 'month' : plan.id === 'yearly' ? 'year' : 'month'}</small>
                </div>
                <div className="lp-plan-desc">{plan.description}</div>

                <div style={{ display: 'grid', gap: 9, margin: '18px 0 26px' }}>
                  {FEATURE_CATALOG.map((f) => {
                    const on = plan.features[f.key];
                    return (
                      <div key={f.key} className={'lp-plan-feat' + (on ? '' : ' lp-plan-feat--off')}>
                        {on ? (
                          <Check size={15} style={{ color: featured ? '#f0d8c0' : 'var(--emerald)' }} />
                        ) : (
                          <Minus size={15} style={{ opacity: 0.5 }} />
                        )}
                        <span style={{ textDecoration: on ? 'none' : 'line-through' }}>{f.label}</span>
                      </div>
                    );
                  })}
                  <div className={'lp-plan-feat' + (plan.galleryLimit === -1 ? '' : ' lp-plan-feat--off')}>
                    {plan.galleryLimit === -1 ? (
                      <Check size={15} style={{ color: featured ? '#f0d8c0' : 'var(--emerald)' }} />
                    ) : (
                      <Minus size={15} style={{ opacity: 0.5 }} />
                    )}
                    <span style={{ textDecoration: plan.galleryLimit === -1 ? 'none' : 'line-through' }}>
                      {galleryLabel(plan.galleryLimit)}
                    </span>
                  </div>
                </div>

                <button
                  type="button"
                  className={featured ? 'lp-btn lp-btn-warm' : plan.free ? 'lp-btn lp-btn-ghost' : 'lp-btn lp-btn-primary'}
                  style={{ marginTop: 'auto' }}
                  onClick={onGetStarted}
                >
                  {plan.free ? 'Start free' : 'Get Pro'}
                </button>
              </motion.div>
            );
          })}
        </div>

        <motion.p className="lp-muted" style={{ textAlign: 'center', marginTop: 26 }} {...fadeUp} transition={{ duration: 0.45 }}>
          Cancel anytime · Paid securely via Razorpay · Plans rights-manageable by the admin.
        </motion.p>
      </section>

      {/* ── final CTA ── */}
      <section className="lp-wrap lp-section lp-section--tight">
        <motion.div
          className="lp-band"
          initial={{ opacity: 0, y: 26 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.55 }}
        >
          <h2 className="lp-h2" style={{ fontSize: 'clamp(1.8rem, 3.4vw, 2.6rem)' }}>
            Ready to draw in the air?
          </h2>
          <p className="lp-lead" style={{ marginTop: 16, margin: '16px auto 0', maxWidth: '30rem', color: 'rgba(241,238,232,0.78)' }}>
            Allow camera access, hold up one finger, and the first line is a second away.
          </p>
          <button type="button" className="lp-btn lp-btn-warm" style={{ marginTop: 32 }} onClick={onGetStarted}>
            Get Started
            <ArrowRight size={16} />
          </button>
        </motion.div>
      </section>

      <footer className="lp-wrap">
        <div className="lp-foot">
          <span>Scribble Air Draw</span>
          <span>Draw in the air with nothing but a webcam.</span>
        </div>
      </footer>
    </div>
  );
}