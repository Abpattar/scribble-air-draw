import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export function NicknameScreen({ onContinue }: { onContinue: (nickname: string) => Promise<void> }) {
  const [nickname, setNickname] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  async function go() {
    if (!nickname.trim()) {
      setStatus('Please enter a nickname.');
      return;
    }
    setBusy(true);
    setStatus('Saving…');
    await onContinue(nickname.trim());
    setBusy(false);
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.4 }}
      className="stage-shell"
    >
      <motion.div
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
        style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18 }}
      >
        <span className="lp-eyebrow">Almost there</span>
        <div className="stage-title">What should we call you?</div>
        <div className="stage-copy">
          This name is shown instead of your email around the app.
        </div>
        <div className="stage-form">
          <input
            className="auth-input text-center"
            placeholder="Nickname"
            maxLength={24}
            autoComplete="off"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && go()}
          />
          <button type="button" className="auth-submit" onClick={go} disabled={busy}>
            Continue
          </button>
        </div>
        <div className={'stage-status' + (status === 'Saving…' ? ' stage-status--ok' : '')}>{status}</div>
      </motion.div>
    </motion.div>
  );
}

export function WelcomeScreen({
  nickname,
  isNew,
  onContinue,
}: {
  nickname: string | null;
  isNew: boolean;
  onContinue: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.4 }}
      className="stage-shell"
    >
      <motion.div
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
        style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18 }}
      >
        <div className="stage-title">
          {nickname ? `Welcome, ${nickname}` : 'Welcome back'}
        </div>
        <div className="stage-copy">
          {isNew
            ? 'Your account is set up. Allow camera access and the studio is ready for your first line.'
            : 'Great to see you again — your drawings are right where you left them.'}
        </div>
        <button type="button" className="auth-submit" style={{ maxWidth: 260 }} onClick={onContinue}>
          Let&rsquo;s Draw
        </button>
      </motion.div>
    </motion.div>
  );
}

export function LoadOverlay({ pct, msg }: { pct: number; msg: string }) {
  return (
    <AnimatePresence>
      <motion.div
        exit={{ opacity: 0 }}
        transition={{ duration: 0.6 }}
        className="stage-shell stage-shell--load"
      >
        <div className="stage-spinner" />
        <div className="stage-title" style={{ fontSize: '1.5rem' }}>
          Scribble Air Draw
        </div>
        <div className="stage-progress">
          <motion.i
            initial={false}
            animate={{ width: pct + '%' }}
            transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          />
        </div>
        <div className="stage-copy" style={{ fontSize: '0.82rem' }}>{msg}</div>
      </motion.div>
    </AnimatePresence>
  );
}