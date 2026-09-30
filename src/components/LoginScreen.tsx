import { motion } from 'framer-motion';
import { SignIn } from '@clerk/clerk-react';
import { Hand, Scan, Cloud } from 'lucide-react';

const clerkAppearance = {
  variables: {
    colorPrimary: '#246a56',
    colorBackground: 'transparent',
    colorInputBackground: 'rgba(255,255,255,0.72)',
    colorInputText: '#143c35',
    colorText: '#143c35',
    colorTextSecondary: 'rgba(20,60,53,0.58)',
    colorInputBorder: 'rgba(20,60,53,0.14)',
    colorNeutral: '#143c35',
    borderRadius: '16px',
    fontSize: '14px',
  },
  elements: {
    rootBox: { width: '100%', background: 'transparent', boxShadow: 'none' },
    cardBox: { background: 'transparent', boxShadow: 'none', borderRadius: '0' },
    card: { background: 'transparent', boxShadow: 'none', width: '100%', padding: '0' },
    footer: { background: 'transparent' },
    headerTitle: { fontSize: '1.4rem', fontWeight: '700', letterSpacing: '-0.025em', color: '#143c35' },
    headerSubtitle: { fontSize: '13px', color: 'rgba(20,60,53,0.58)' },
    formButtonPrimary: {
      background: '#246a56',
      color: '#f6f4ef',
      fontWeight: '700',
      boxShadow: '0 14px 28px -14px rgba(36,106,86,0.65)',
    },
    formFieldInput: { borderRadius: '16px', padding: '12px 14px' },
    formFieldLabel: { fontSize: '12.5px', fontWeight: '600', color: 'rgba(20,60,53,0.72)' },
    formFieldInputPlaceholder: { color: 'rgba(20,60,53,0.42)' },
    formFieldErrorText: { color: '#9e4526', fontSize: '12px' },
    socialButtonsBlockButton: {
      background: 'rgba(255,255,255,0.72)',
      fontWeight: '600',
      border: '1px solid rgba(20,60,53,0.12)',
      color: '#143c35',
    },
    socialButtonsBlockButtonText: { color: '#143c35' },
    socialButtonsIconButton: { color: '#143c35' },
    dividerLine: { background: 'rgba(20,60,53,0.12)' },
    dividerText: { color: 'rgba(20,60,53,0.44)', fontSize: '11.5px' },
    footerActionLink: { color: '#246a56', fontWeight: '600' },
    footerActionText: { color: 'rgba(20,60,53,0.58)' },
    identityBarText: { color: 'rgba(20,60,53,0.5)' },
    alertBox: { background: 'rgba(158,69,38,0.09)', color: '#8f3f20' },
  },
};

const FACTS = [
  { Icon: Scan, text: 'Your webcam feed becomes the canvas.' },
  { Icon: Hand, text: 'One finger draws. Two fingers move the picture.' },
  { Icon: Cloud, text: 'Every drawing is already saved to your account.' },
];

export default function LoginScreen() {
  return (
    <div className="auth-shell">
      <div className="auth-bg" aria-hidden="true" />

      <div className="auth-scroll">
        <div className="auth-grid">
          <motion.div
            className="auth-pitch"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="lp-brand">
              <span className="lp-mark">
                <Hand size={17} strokeWidth={2.2} />
              </span>
              Scribble Air Draw
            </div>

            <h1 className="auth-title">Your drawings are waiting for you.</h1>

            <p className="lp-lead">
              Sign in to open the studio. Everything you have drawn is saved to your account, so it
              is exactly where you left it.
            </p>

            <div className="auth-facts">
              {FACTS.map((f) => (
                <div key={f.text} className="auth-fact">
                  <span className="auth-fact-icon">
                    <f.Icon size={15} strokeWidth={2} />
                  </span>
                  <span>{f.text}</span>
                </div>
              ))}
            </div>
          </motion.div>

          <motion.div
            className="auth-card"
            initial={{ opacity: 0, y: 20, scale: 0.99 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ delay: 0.12, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          >
            <SignIn routing="virtual" appearance={clerkAppearance} />
          </motion.div>
        </div>
      </div>
    </div>
  );
}
