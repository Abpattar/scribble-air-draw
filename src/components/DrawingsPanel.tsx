import { useState } from 'react';
import {
  Search,
  Star,
  Pencil,
  Copy,
  Trash2,
  Plus,
  Sticker,
  X,
  Cloud,
  Images,
} from 'lucide-react';

interface Props {
  open: boolean;
  left?: number;
  names: string[];
  favorites: Record<string, boolean>;
  currentName: string;
  saveStatus: string;
  onSwitch: (name: string) => void;
  onToggleFavorite: (name: string) => void;
  onRename: (name: string) => void;
  onDuplicate: (name: string) => void;
  onDelete: (name: string) => void;
  onNew: (name: string) => void;
  onTemplates: () => void;
  onClose: () => void;
}

export default function DrawingsPanel(p: Props) {
  const [query, setQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [newName, setNewName] = useState('');

  if (!p.open) return null;

  const names = p.names
    .filter((n) => n.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => (p.favorites[b] ? 1 : 0) - (p.favorites[a] ? 1 : 0));

  return (
    <div className="sc-drawings" style={p.left != null ? { left: p.left } : undefined} role="dialog" aria-label="My drawings">
      <div className="sc-drawings-head">
        <div className="sc-drawings-title">
          <Images size={14} /> Drawings
        </div>
        <div className="sc-drawings-actions">
          <button type="button" className="gmini" title="Search drawings" aria-label="Search drawings" onClick={() => setShowSearch((s) => !s)}>
            <Search size={15} />
          </button>
          <button type="button" className="gmini" title="Close" aria-label="Close drawings" onClick={p.onClose}>
            <X size={15} />
          </button>
        </div>
      </div>

      {showSearch && (
        <input
          className="field-input"
          placeholder="Search drawings…"
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}

      <div className="sc-drawlist">
        {!names.length && <div className="stat-row" style={{ border: 'none' }}>{query ? 'No drawings match.' : 'No drawings yet — make one!'}</div>}
        {names.map((name) => (
          <div key={name} className={'sc-drow' + (name === p.currentName ? ' active' : '')}>
            <span
              className={'gmini star' + (p.favorites[name] ? ' fav' : '')}
              title="Favorite"
              aria-label="Favorite"
              onClick={(e) => { e.stopPropagation(); p.onToggleFavorite(name); }}
            >
              <Star size={14} fill={p.favorites[name] ? 'currentColor' : 'none'} />
            </span>
            <span className="gname" onClick={() => p.onSwitch(name)}>{name}</span>
            <span className="gmini" title="Rename" aria-label="Rename" onClick={(e) => { e.stopPropagation(); p.onRename(name); }}>
              <Pencil size={13} />
            </span>
            <span className="gmini" title="Duplicate" aria-label="Duplicate" onClick={(e) => { e.stopPropagation(); p.onDuplicate(name); }}>
              <Copy size={13} />
            </span>
            <span className="gmini" title="Delete" aria-label="Delete" onClick={(e) => { e.stopPropagation(); p.onDelete(name); }}>
              <Trash2 size={13} />
            </span>
          </div>
        ))}
      </div>

      <input
        className="field-input"
        placeholder="New drawing name"
        autoComplete="off"
        value={newName}
        onChange={(e) => setNewName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { p.onNew(newName); setNewName(''); } }}
      />
      <div className="gbtn" onClick={() => { p.onNew(newName); setNewName(''); }}>
        <Plus size={14} style={{ color: 'var(--kid-green)' }} /> New Drawing
      </div>
      <div className="gbtn" onClick={p.onTemplates}>
        <Sticker size={15} style={{ color: 'var(--kid-blue)' }} /> Trace Templates
      </div>

      <div className="sc-drawings-foot">
        <div className="sc-savestatus">{p.saveStatus}</div>
        <div className="sc-cloudnote">
          <Cloud size={11} /> Saved to your account — log in anywhere to access it
        </div>
      </div>
    </div>
  );
}