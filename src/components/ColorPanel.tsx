import { useRef, useState } from 'react';
import { Plus, Eraser, Sparkles } from 'lucide-react';
import type { Color } from '../lib/engine';
import { useClickOutside } from '../lib/useClickOutside';

const SWATCHES: Color[] = [
  { r: 0, g: 220, b: 255 },
  { r: 255, g: 0, b: 200 },
  { r: 255, g: 230, b: 0 },
  { r: 60, g: 255, b: 100 },
  { r: 255, g: 255, b: 255 },
  { r: 180, g: 80, b: 255 },
  { r: 255, g: 80, b: 30 },
  { r: 255, g: 140, b: 200 },
  { r: 90, g: 160, b: 255 },
  { r: 0, g: 255, b: 170 },
  { r: 255, g: 210, b: 120 },
  { r: 140, g: 255, b: 60 },
];

function rgbToHex(c: Color) {
  const h = (n: number) => n.toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}
function hexToRgb(hex: string): Color {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

interface Props {
  color: Color;
  onColor: (c: Color) => void;
  size: number;
  onSize: (v: number) => void;
  isEraser: boolean;
  gradientOn: boolean;
  onGradient: () => void;
}

export default function ColorPanel(p: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const customInputRef = useRef<HTMLInputElement>(null);
  useClickOutside([wrapRef], open, () => setOpen(false));

  const sameColor = (c: Color) => c.r === p.color.r && c.g === p.color.g && c.b === p.color.b;
  const isCustomColor = !p.isEraser && !SWATCHES.some(sameColor);

  return (
    <div className="sc-color-wrap" ref={wrapRef}>
      <button
        type="button"
        className="sc-color-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-label="Colors and brush"
        aria-expanded={open}
        title={p.isEraser ? 'Eraser active — colors and brush' : `Color ${rgbToHex(p.color)} — brush size ${p.size}`}
      >
        {p.isEraser ? (
          <Eraser size={20} className="sc-color-eraser" />
        ) : (
          <span
            className="sc-color-dot"
            style={{ background: `rgb(${p.color.r},${p.color.g},${p.color.b})` }}
          />
        )}
      </button>

      {open && (
        <div className="sc-color-pop" role="dialog" aria-label="Colors and brush">
          <div className="sc-pop-seclbl">Color</div>
          <div className="sc-swatches">
            {SWATCHES.map((c, i) => (
              <button
                key={i}
                type="button"
                className={'swatch' + (sameColor(c) && !p.isEraser ? ' active' : '')}
                style={{ background: `rgb(${c.r},${c.g},${c.b})` }}
                onClick={() => p.onColor(c)}
                aria-label={`Color ${rgbToHex(c)}`}
              />
            ))}
            <button
              type="button"
              className={'sc-swatch-custom' + (isCustomColor ? ' active' : '')}
              style={{
                background: isCustomColor ? `rgb(${p.color.r},${p.color.g},${p.color.b})` : 'conic-gradient(red,yellow,lime,cyan,blue,magenta,red)',
              }}
              title="Custom color"
              aria-label="Pick a custom color"
              onClick={() => customInputRef.current?.click()}
            >
              {!isCustomColor && <Plus size={13} color="#fff" style={{ filter: 'drop-shadow(0 0 2px rgba(0,0,0,0.8))' }} />}
            </button>
            <input
              ref={customInputRef}
              type="color"
              value={rgbToHex(p.color)}
              onChange={(e) => p.onColor(hexToRgb(e.target.value))}
              style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }}
            />
          </div>

          <div className="sc-pop-seclbl">Brush</div>
          <div className="sc-size-row">
            <input
              className="sc-size-input"
              type="range"
              min={0.5}
              max={40}
              step={0.5}
              value={p.size}
              onChange={(e) => p.onSize(+e.target.value)}
              aria-label="Brush size"
            />
            <span className="sc-size-val">{p.size}</span>
          </div>

          <button
            type="button"
            className={'sc-popbtn' + (p.gradientOn ? ' active' : '')}
            onClick={p.onGradient}
            aria-pressed={p.gradientOn}
          >
            <Sparkles size={15} />
            <span>Gradient stroke</span>
            {p.gradientOn && <span className="sc-popcheck">•</span>}
          </button>
        </div>
      )}
    </div>
  );
}