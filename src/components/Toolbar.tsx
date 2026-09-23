import { useRef, useState } from 'react';
import {
  Pencil,
  Slash,
  Circle,
  Square,
  PaintBucket,
  Eraser,
  Undo2,
  Trash2,
  MoreHorizontal,
  Sparkles,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Image as ImageIcon,
  Camera,
  Paintbrush,
  FlipHorizontal2,
  Download,
  Layers,
  Play,
  Video,
  Sun,
  Moon,
} from 'lucide-react';
import type { ToolType } from '../lib/engine';
import { useClickOutside } from '../lib/useClickOutside';

const TOOLS: { id: ToolType; label: string; Icon: typeof Pencil }[] = [
  { id: 'freehand', label: 'Pen', Icon: Pencil },
  { id: 'line', label: 'Line', Icon: Slash },
  { id: 'circle', label: 'Circle', Icon: Circle },
  { id: 'rect', label: 'Rectangle', Icon: Square },
  { id: 'fill', label: 'Fill', Icon: PaintBucket },
];

interface Props {
  tool: ToolType;
  onTool: (t: ToolType) => void;
  isEraser: boolean;
  onEraser: () => void;
  onUndo: () => void;
  onClear: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onBgImage: () => void;
  camPaused: boolean;
  onCamToggle: () => void;
  canvasMode: boolean;
  onCanvasMode: () => void;
  onPipFlip: () => void;
  transparentExport: boolean;
  onTransparent: () => void;
  onExport: () => void;
  onReplay: () => void;
  onRecord: () => void;
  recording: boolean;
  theme: 'dark' | 'light';
  onTheme: () => void;
}

function SegLabel({ children }: { children: React.ReactNode }) {
  return <div className="sc-pop-seclbl">{children}</div>;
}

function PopRow({
  Icon,
  label,
  onClick,
  active,
  toggle,
}: {
  Icon: typeof Pencil;
  label: string;
  onClick: () => void;
  active?: boolean;
  toggle?: boolean;
}) {
  return (
    <button
      type="button"
      className={'sc-popbtn' + (active ? ' active' : '')}
      onClick={onClick}
      aria-pressed={toggle ? Boolean(active) : undefined}
      title={label}
    >
      <Icon size={15} strokeWidth={2} />
      <span>{label}</span>
      {active && toggle && <span className="sc-popcheck">•</span>}
    </button>
  );
}

export default function Toolbar(p: Props) {
  const [moreOpen, setMoreOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  useClickOutside([rootRef], moreOpen, () => setMoreOpen(false));

  return (
    <div className="sc-toolbar" ref={rootRef} role="toolbar" aria-label="Drawing tools">
      <div className="sc-toolbar-scroll">
        {TOOLS.map((t) => {
          const active = p.tool === t.id && !p.isEraser;
          return (
            <button
              key={t.id}
              type="button"
              className={'sc-tbtn' + (active ? ' active' : '')}
              onClick={() => p.onTool(t.id)}
              aria-label={t.label}
              aria-pressed={active}
              title={t.label}
            >
              <t.Icon size={17} strokeWidth={2} />
            </button>
          );
        })}

        <div className="sc-tdiv" />

        <button
          type="button"
          className={'sc-tbtn' + (p.isEraser ? ' active' : '')}
          onClick={p.onEraser}
          aria-label="Eraser"
          aria-pressed={p.isEraser}
          title="Eraser"
        >
          <Eraser size={17} strokeWidth={2} />
        </button>
        <button type="button" className="sc-tbtn" onClick={p.onUndo} aria-label="Undo" title="Undo">
          <Undo2 size={17} strokeWidth={2} />
        </button>
        <button type="button" className="sc-tbtn" onClick={p.onClear} aria-label="Clear drawing" title="Clear drawing">
          <Trash2 size={17} strokeWidth={2} />
        </button>
      </div>

      <div className="sc-tdiv" />

      <div className="sc-tbtnwrap" ref={moreRef}>
        <button
          type="button"
          className={'sc-tbtn' + (moreOpen ? ' active' : '')}
          onClick={() => setMoreOpen((o) => !o)}
          aria-label="More tools"
          aria-expanded={moreOpen}
          title="More tools"
        >
          <MoreHorizontal size={18} strokeWidth={2} />
        </button>

        {moreOpen && (
          <div className="sc-pop" role="menu" aria-label="More tools">
            <SegLabel>View</SegLabel>
            <div className="sc-pop-row">
              <button type="button" className="sc-popbtn" onClick={() => { p.onZoomIn(); }} title="Zoom in">
                <ZoomIn size={15} /> Zoom in
              </button>
              <button type="button" className="sc-popbtn" onClick={() => { p.onZoomOut(); }} title="Zoom out">
                <ZoomOut size={15} /> Zoom out
              </button>
              <button type="button" className="sc-popbtn" onClick={() => { p.onZoomReset(); }} title="Reset view">
                <RotateCcw size={15} /> Reset
              </button>
            </div>

            <SegLabel>Canvas</SegLabel>
            <PopRow Icon={ImageIcon} label="Background image" onClick={p.onBgImage} />
            <PopRow Icon={Camera} label={p.camPaused ? 'Camera paused' : 'Camera feed'} onClick={p.onCamToggle} active={p.camPaused} toggle />
            <PopRow Icon={Paintbrush} label="White canvas mode" onClick={p.onCanvasMode} active={p.canvasMode} toggle />
            <PopRow Icon={FlipHorizontal2} label="Flip camera bubble" onClick={p.onPipFlip} />

            <SegLabel>Export & share</SegLabel>
            <PopRow Icon={Play} label="Replay drawing" onClick={p.onReplay} />
            <PopRow Icon={Video} label="Record video" onClick={p.onRecord} active={p.recording} toggle />
            <PopRow Icon={Download} label="Export PNG" onClick={p.onExport} />
            <PopRow Icon={Layers} label="Transparent PNG" onClick={p.onTransparent} active={p.transparentExport} toggle />

            <SegLabel>App</SegLabel>
            <PopRow
              Icon={p.theme === 'light' ? Moon : Sun}
              label={p.theme === 'light' ? 'Switch to dark' : 'Switch to light'}
              onClick={p.onTheme}
            />
          </div>
        )}
      </div>
    </div>
  );
}