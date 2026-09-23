import { useEffect, type RefObject } from 'react';

// Closes an open popover when the user clicks/taps outside of it or presses
// Escape. `refs` are containers that should NOT trigger a close.
export function useClickOutside(
  refs: RefObject<HTMLElement | null>[],
  active: boolean,
  onClose: () => void
) {
  useEffect(() => {
    if (!active) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (refs.some((r) => r.current?.contains(t))) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [refs, active, onClose]);
}