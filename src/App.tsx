import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { Menu } from 'lucide-react';
import { DrawEngine, type Color, type ToolType, type Stroke } from './lib/engine';
import { useAuth } from './hooks/useAuth';
import { useProfile, type Features } from './hooks/useProfile';
import { useApi } from './hooks/useApi';
import LandingScreen from './components/LandingScreen';
import LoginScreen from './components/LoginScreen';
import { NicknameScreen, WelcomeScreen, LoadOverlay } from './components/StageOverlays';
import Toolbar from './components/Toolbar';
import ColorPanel from './components/ColorPanel';
import NavPanel from './components/NavPanel';
import DrawingsPanel from './components/DrawingsPanel';
import { StatsModal, HistoryModal, ProfileModal } from './components/Modals';
import TemplatesModal from './components/TemplatesModal';
import SubscriptionModal from './components/SubscriptionModal';
import FriendsModal from './components/FriendsModal';
import GroupsModal, { type Group } from './components/GroupsModal';
import CompetitionsModal from './components/CompetitionsModal';
import AdminPage from './components/AdminPage';
import type { Template } from './lib/templates';

const CHALLENGES = [
  'Draw a creature that lives in clouds', 'Draw your morning coffee', 'Draw a robot pet',
  'Draw a city skyline at midnight', 'Draw something that only exists in dreams',
  'Draw your favorite season', 'Draw a plant from another planet', 'Draw a musical instrument',
  'Draw a doorway to somewhere unexpected', 'Draw a constellation of your own',
  'Draw a vehicle with wings', 'Draw the inside of a volcano', 'Draw a friendly monster',
  'Draw a floating island', "Draw your name in one continuous line",
];
function todaysChallenge() {
  const start = new Date(new Date().getFullYear(), 0, 0);
  const diff = new Date().getTime() - start.getTime();
  const dayOfYear = Math.floor(diff / 86400000);
  return CHALLENGES[dayOfYear % CHALLENGES.length];
}

type Stage = 'boot' | 'landing' | 'login' | 'nickname' | 'welcome' | 'app' | 'admin';

export default function App() {
  const bgCanvasRef = useRef<HTMLCanvasElement>(null);
  const drawCanvasRef = useRef<HTMLCanvasElement>(null);
  const camRef = useRef<HTMLVideoElement>(null);
  const engineRef = useRef<DrawEngine | null>(null);
  const bgImgInputRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);

  const { user, logout } = useAuth();
  const profile = useProfile();
  const api = useApi();

  const [stage, setStage] = useState<Stage>('boot');
  const [isNewUser, setIsNewUser] = useState(false);
  const [showLoadOverlay, setShowLoadOverlay] = useState(false);
  const [loadPct, setLoadPct] = useState(0);
  const [loadMsg, setLoadMsg] = useState('Starting…');

  const [theme, setTheme] = useState<'dark' | 'light'>('light');
  const [navOpen, setNavOpen] = useState(false);
  const [drawingsOpen, setDrawingsOpen] = useState(false);

  const [color, setColorState] = useState<Color>({ r: 0, g: 220, b: 255 });
  const [tool, setToolState] = useState<ToolType>('freehand');
  const [size, setSizeState] = useState(2);
  const [isEraser, setIsEraser] = useState(false);
  const [gradientOn, setGradientOn] = useState(false);
  const [transparentExport, setTransparentExport] = useState(false);
  const [camPaused, setCamPaused] = useState(false);
  const [canvasMode, setCanvasMode] = useState(false);
  const [recording, setRecording] = useState(false);
  const [bgImageActive, setBgImageActive] = useState(false);
  const [cameraSleeping, setCameraSleeping] = useState(false);
  const [friendRequests, setFriendRequests] = useState(0);

  const [hint, setHint] = useState('Initialising…');
  const [modeBadge, setModeBadge] = useState({ cls: '', text: '' });
  const [zoomPct, setZoomPct] = useState(100);
  const [zoomShow, setZoomShow] = useState(false);
  const [dot, setDot] = useState({ show: false, x: 0, y: 0, size: 0, color: '', glow: '' });

  const hintRef = useRef('');
  const modeBadgeRef = useRef({ cls: '', text: '' });
  const dotRef = useRef<{ show: boolean; x: number; y: number; size: number; color: string; glow: string } | null>(null);

  const [modal, setModal] = useState<
    null | 'stats' | 'history' | 'profile' | 'templates' | 'friends' | 'groups' | 'battles' | 'plan'
  >(null);
  const [planReason, setPlanReason] = useState('');
  const [battleSource, setBattleSource] = useState<Group | null>(null);
  const [strokesTick, setStrokesTick] = useState(0); // bump to re-render stats/history reading engine
  const challengeText = useRef(todaysChallenge()).current;

  // ── init engine once canvases exist ──
  useEffect(() => {
    if (!bgCanvasRef.current || !drawCanvasRef.current || !camRef.current) return;
    const engine = new DrawEngine(bgCanvasRef.current, drawCanvasRef.current, camRef.current, {
      onProgress: (pct, msg) => { setLoadPct(pct); setLoadMsg(msg); },
      onReady: () => setShowLoadOverlay(false),
      onHint: (h) => {
        if (hintRef.current !== h) {
          hintRef.current = h;
          setHint(h);
        }
      },
      onModeBadge: (cls, text) => {
        const cur = modeBadgeRef.current;
        if (cur.cls !== cls || cur.text !== text) {
          modeBadgeRef.current = { cls, text };
          setModeBadge({ cls, text });
        }
      },
      onZoomFlash: (pct) => {
        setZoomPct(pct);
        setZoomShow(true);
        clearTimeout((window as any)._zoomT);
        (window as any)._zoomT = setTimeout(() => setZoomShow(false), 1200);
      },
      onStrokesChanged: () => {
        setStrokesTick((t) => t + 1);
        if (engineRef.current) profile.scheduleSave(engineRef.current);
      },
      onDot: (show, x, y, sz, c, glow) => {
        const cur = dotRef.current;
        if (cur && cur.show === show && cur.x === x && cur.y === y && cur.size === sz && cur.color === c && cur.glow === glow) return;
        const next = { show, x, y, size: sz, color: c, glow };
        dotRef.current = next;
        setDot(next);
      },
      onCamIdle: () => setCameraSleeping(true),
      onCamWake: () => { setCameraSleeping(false); setShowLoadOverlay(false); },
    });
    engineRef.current = engine;

    const onResize = () => engine.resize();
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', () => setTimeout(onResize, 250));
    const vv = (window as any).visualViewport;
    vv?.addEventListener('resize', onResize);

    ['gesturestart', 'gesturechange', 'gestureend'].forEach((ev) =>
      document.addEventListener(ev, (e) => e.preventDefault())
    );

    return () => {
      window.removeEventListener('resize', onResize);
      vv?.removeEventListener('resize', onResize);
      engine.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── boot: wait for auth state ──
  useEffect(() => {
    if (user === undefined) return; // still loading
    if (user === null) {
      profile.reset();
      // First-ever load shows the landing page; a logout later goes straight to login.
      setStage((s) => (s === 'boot' ? 'landing' : 'login'));
      return;
    }
    // user logged in
    (async () => {
      const engine = engineRef.current!;
      const nickname = await profile.load(user, engine);
      if (!nickname) {
        setStage('nickname');
      } else {
        setIsNewUser(false);
        enterApp();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const enterApp = useCallback(() => {
    setStage('app');
    // On phones/tablets the nav rail starts hidden behind the hamburger so the
    // camera stays dominant; on desktop it shows as a compact icon rail.
    setNavOpen(false);
    setDrawingsOpen(false);
  }, []);

  useEffect(() => {
    if (stage !== 'app') {
      // Leaving the studio (admin page, welcome, logout…) releases the webcam.
      const engine = engineRef.current;
      if (engine?.mpReady) engine.hibernate();
      return;
    }
    const startTimer = window.setTimeout(() => {
      const engine = engineRef.current;
      if (!engine) return;
      if (engine.mpReady) {
        // Coming back to the canvas: restart the camera if it was hibernated.
        if (engine.cameraOffForIdle) void engine.resumeCamera();
        return;
      }
      setShowLoadOverlay(true);
      void engine.start().finally(() => setShowLoadOverlay(false));
    }, 0);
    return () => window.clearTimeout(startTimer);
  }, [stage]);

  const refreshFriendBadge = useCallback(async () => {
    try {
      const d = await api.get('/api/friends/requests');
      setFriendRequests(typeof d?.count === 'number' ? d.count : 0);
    } catch {
      /* ignore polls while signed out / offline */
    }
  }, [api]);

  useEffect(() => {
    if (stage !== 'app' || !user) return;
    void refreshFriendBadge();
    const t = setInterval(refreshFriendBadge, 25000);
    return () => clearInterval(t);
  }, [stage, user, refreshFriendBadge]);

  function handleGetStarted() {
    setStage('login');
  }

  async function handleNicknameContinue(nickname: string) {
    setIsNewUser(true);
    try {
      await profile.saveNicknameOnly(nickname);
    } catch (error) {
      console.error('Failed to save nickname:', error);
      alert('Could not save your nickname — the save server is unreachable. You can still draw; it will save again later.');
    }
    enterApp();
  }

  function handleLogout() {
    logout();
  }

  // ── panel handlers ──
  const eng = () => engineRef.current;
  const gate = (feature: keyof Features, reason: string): boolean => {
    if (profile.features[feature]) return true;
    setPlanReason(reason);
    setModal('plan');
    return false;
  };
  const onColor = (c: Color) => {
    const engine = eng();
    if (!engine) return;
    setColorState(c);
    setIsEraser(false);
    engine.setColor(c);
  };
  const onTool = (t: ToolType) => {
    const engine = eng();
    if (!engine) return;
    setToolState(t);
    setIsEraser(false);
    engine.setTool(t);
  };
  const onSize = (v: number) => {
    const engine = eng();
    if (!engine) return;
    setSizeState(v);
    engine.setSize(v);
  };
  const onEraserToggle = () => {
    const engine = eng();
    if (!engine) return;
    setIsEraser(engine.toggleEraser());
  };
  const onGradientToggle = () => {
    const engine = eng();
    if (!engine) return;
    setGradientOn(engine.toggleGradient());
  };
  const onUndo = () => eng()?.undo();
  const onClear = () => eng()?.clear();
  const onZoomIn = () => eng()?.zoomBy(1.25);
  const onZoomOut = () => eng()?.zoomBy(0.8);
  const onZoomReset = () => eng()?.zoomReset();
  const onCamToggle = () => {
    const engine = eng();
    if (!engine) return;
    setCamPaused(engine.toggleCamPause());
  };
  const onCanvasModeToggle = () => {
    const engine = eng();
    if (!engine) return;
    setCanvasMode(engine.toggleCanvasMode());
  };
  const onPipFlip = () => eng()?.flipPip();
  const onTransparentToggle = () => {
    if (!gate('export_transparent', 'Unlock transparent PNG export with Pro.')) return;
    const engine = eng();
    if (!engine) return;
    setTransparentExport(engine.toggleTransparentExport());
  };
  const onExport = () => eng()?.exportPNG(profile.currentName);
  const onPickTemplate = async (tpl: Template) => {
    if (!tpl.free && !gate('templates', 'Unlock the trace template library with Pro.')) return;
    const engine = eng();
    if (!engine) return;
    await engine.setBgImageFromUrl(tpl.url);
    setCamPaused(true);
    setBgImageActive(true);
  };
  const onRemoveBgImage = () => {
    const engine = eng();
    if (!engine) return;
    engine.clearBgImage();
    setCamPaused(false);
    setBgImageActive(false);
  };
  const onReplay = () => {
    if (!gate('replay', 'Unlock drawing replay with Pro.')) return;
    const engine = eng();
    if (!engine) return;
    if (!engine.getStrokes().length) {
      setHint('✍ Draw something first, then hit replay.');
      return;
    }
    engine.replay();
  };
  const wakeCamera = async () => {
    const engine = engineRef.current;
    if (!engine) return;
    if (await engine.resumeCamera()) {
      setCameraSleeping(false);
      setShowLoadOverlay(false);
    }
  };
  const onRecord = () => {
    if (recording) return;
    if (!gate('record', 'Unlock recording your drawing with Pro.')) return;
    const engine = eng();
    if (!engine) return;
    if (!engine.getStrokes().length) {
      setHint('✍ Draw something first, then hit record.');
      return;
    }
    setRecording(true);
    const rec = engine.record(profile.currentName);
    recorderRef.current = rec || null;
    setTimeout(() => setRecording(false), 400); // engine handles actual stop; badge just pulses
  };
  const onThemeToggle = () => {
    setTheme((t) => {
      const next = t === 'dark' ? 'light' : 'dark';
      document.body.classList.toggle('dark', next === 'dark');
      return next;
    });
  };
  const onBgImageClick = () => {
    if (!gate('background_images', 'Unlock importing your own background image with Pro.')) return;
    bgImgInputRef.current?.click();
  };
  const onBgImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) {
      eng()?.importBgImage(f);
      setCamPaused(true);
      setBgImageActive(true);
    }
  };
  const onNewDrawing = (rawName: string) => {
    const limit = profile.galleryLimit;
    const count = drawingNames.length;
    if (limit >= 0 && count >= limit) {
      setPlanReason(`Free keeps ${limit} drawings in your gallery — Pro is unlimited.`);
      setModal('plan');
      return;
    }
    profile.newDrawing(rawName, eng());
  };

  const drawingNames = Object.keys(profile.drawings);
  const currentStrokes: Stroke[] = engineRef.current?.getStrokes() || [];
  void strokesTick;
  const isMobileLayout =
    typeof window !== 'undefined' &&
    window.matchMedia('(max-width: 760px), (pointer: coarse) and (max-width: 900px)').matches;

  return (
    <div className="transition-colors duration-700 overflow-x-hidden w-full h-full relative">
      <video id="cam" ref={camRef} autoPlay playsInline muted />
      <canvas className="bg-canvas" ref={bgCanvasRef} />
      <canvas className="draw-canvas" ref={drawCanvasRef} />
      {dot.show && (
        <div
          className="dot"
          style={{ left: dot.x, top: dot.y, width: dot.size, height: dot.size, background: dot.color, boxShadow: dot.glow }}
        />
      )}

      {stage === 'app' && (
        <>
          <div id="hint">{hint}</div>
          <div className={'mode-badge ' + modeBadge.cls}>{modeBadge.text}</div>
          <div id="challengeBanner">
            Today's challenge: <b>{challengeText}</b>
          </div>
          <div className={'zoom-indicator' + (zoomShow ? ' show' : '')}>Zoom {zoomPct}%</div>

          {bgImageActive && (
            <div className="sc-chip sc-chip-remove" onClick={onRemoveBgImage} role="button" aria-label="Remove background image">
              ✕ Remove image
            </div>
          )}

          {cameraSleeping && (
            <div className="sc-chip sc-chip-wake" onClick={wakeCamera} role="button" aria-label="Wake the camera">
              😴 Camera is asleep — tap to wake it
            </div>
          )}

          <button
            type="button"
            className="sc-navtoggle"
            onClick={() => setNavOpen((o) => !o)}
            aria-label="Menu"
            aria-expanded={navOpen}
            title="Menu"
          >
            <Menu size={20} />
          </button>

          <NavPanel
            open={navOpen}
            onToggle={() => setNavOpen((o) => !o)}
            mobile={isMobileLayout}
            onNavigate={() => setNavOpen(false)}
            profileLabel={profile.nickname || user?.email || ''}
            isPro={profile.subscribed}
            showAdmin={profile.isAdmin}
            friendRequests={friendRequests}
            drawingsClosed={drawingsOpen}
            onDrawings={() => setDrawingsOpen(true)}
            onNew={() => onNewDrawing('')}
            onTemplates={() => setModal('templates')}
            onStats={() => setModal('stats')}
            onHistory={() => setModal('history')}
            onProfile={() => setModal('profile')}
            onFriends={() => setModal('friends')}
            onGroups={() => setModal('groups')}
            onBattles={() => { setBattleSource(null); setModal('battles'); }}
            onPlan={() => { setPlanReason(''); setModal('plan'); }}
            onAdmin={() => setStage('admin')}
            onLogout={handleLogout}
          />

          <Toolbar
            tool={tool}
            onTool={onTool}
            isEraser={isEraser}
            onEraser={onEraserToggle}
            onUndo={onUndo}
            onClear={onClear}
            onZoomIn={onZoomIn}
            onZoomOut={onZoomOut}
            onZoomReset={onZoomReset}
            onBgImage={onBgImageClick}
            camPaused={camPaused}
            onCamToggle={onCamToggle}
            canvasMode={canvasMode}
            onCanvasMode={onCanvasModeToggle}
            onPipFlip={onPipFlip}
            transparentExport={transparentExport}
            onTransparent={onTransparentToggle}
            onExport={onExport}
            onReplay={onReplay}
            onRecord={onRecord}
            recording={recording}
            theme={theme}
            onTheme={onThemeToggle}
          />

          <ColorPanel
            color={color}
            onColor={onColor}
            size={size}
            onSize={onSize}
            isEraser={isEraser}
            gradientOn={gradientOn}
            onGradient={onGradientToggle}
          />

          {drawingsOpen && (
            <DrawingsPanel
              open={drawingsOpen}
              left={isMobileLayout ? undefined : navOpen ? 216 : 74}
              names={drawingNames}
              favorites={profile.favorites}
              currentName={profile.currentName}
              saveStatus={profile.saveStatus}
              onSwitch={(name) => profile.switchDrawing(name, eng())}
              onToggleFavorite={(name) => profile.toggleFavorite(name, eng())}
              onRename={(name) => {
                const nn = prompt(`Rename "${name}" to:`, name);
                if (nn) profile.renameDrawing(name, nn, eng());
              }}
              onDuplicate={(name) => profile.duplicateDrawing(name, eng())}
              onDelete={(name) => profile.deleteDrawing(name, eng())}
              onNew={onNewDrawing}
              onTemplates={() => setModal('templates')}
              onClose={() => setDrawingsOpen(false)}
            />
          )}
          <input type="file" ref={bgImgInputRef} accept="image/*" style={{ display: 'none' }} onChange={onBgImageChange} />

          {modal === 'stats' && (
            <StatsModal
              onClose={() => setModal(null)}
              currentName={profile.currentName}
              strokes={currentStrokes}
              drawStartTime={profile.drawStartTime.current}
              totalDrawings={drawingNames.length}
            />
          )}
          {modal === 'history' && (
            <HistoryModal
              onClose={() => setModal(null)}
              history={profile.history[profile.currentName] || []}
              onRestore={(snap) => { profile.restoreVersion(snap, eng()); setModal(null); }}
            />
          )}
          {modal === 'templates' && (
            <TemplatesModal
              onClose={() => setModal(null)}
              subscribed={profile.subscribed}
              plan={profile.plan}
              subscribedUntil={profile.subscribedUntil}
              payments={profile.payments}
              templatesAllowed={profile.features.templates}
              onSubscribe={() => profile.refresh()}
              onCancel={() => profile.refresh()}
              onPick={onPickTemplate}
            />
          )}
          {modal === 'plan' && (
            <SubscriptionModal
              subscribed={profile.subscribed}
              plan={profile.plan}
              subscribedUntil={profile.subscribedUntil}
              payments={profile.payments}
              reason={planReason || undefined}
              onClose={() => { setPlanReason(''); setModal(null); }}
              onSubscribed={() => profile.refresh()}
              onCancel={() => profile.refresh()}
            />
          )}
          {modal === 'friends' && <FriendsModal onClose={() => setModal(null)} onChange={() => void refreshFriendBadge()} />}
          {modal === 'groups' && (
            <GroupsModal
              onClose={() => setModal(null)}
              onChallenge={(g) => { setBattleSource(g); setModal('battles'); }}
            />
          )}
          {modal === 'battles' && (
            <CompetitionsModal
              onClose={() => { setBattleSource(null); setModal(null); }}
              sourceGroup={battleSource}
              getStrokes={() => eng().getStrokes()}
              canBattle={profile.features.battles}
            />
          )}
          {modal === 'profile' && (
            <ProfileModal
              onClose={() => setModal(null)}
              nickname={profile.nickname}
              bio={profile.bio}
              email={user?.email}
              drawingCount={drawingNames.length}
              onSave={(name, bio) => profile.saveProfileDetails(name, bio)}
            />
          )}

        </>
      )}

      <AnimatePresence>
        {stage === 'nickname' && <NicknameScreen key="nickname" onContinue={handleNicknameContinue} />}
        {stage === 'welcome' && (
          <WelcomeScreen key="welcome" nickname={profile.nickname} isNew={isNewUser} onContinue={enterApp} />
        )}
      </AnimatePresence>

      {stage === 'landing' && <LandingScreen onGetStarted={handleGetStarted} />}

      {stage === 'login' && <LoginScreen />}

      {stage === 'admin' && (
        <AdminPage
          superadmin={profile.isSuperadmin}
          onBack={enterApp}
          onChanged={() => void profile.refresh().catch(() => {})}
        />
      )}

      {showLoadOverlay && <LoadOverlay pct={loadPct} msg={loadMsg} />}
    </div>
  );
}