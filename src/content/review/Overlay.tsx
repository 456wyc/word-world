import { useEffect, useState } from 'react';
import type { Entry, Rating, ReviewMode, ReviewPosition } from '../../shared/types';
import { BarrageMode } from './BarrageMode';
import { CardMode } from './CardMode';
import { SubtitleMode } from './SubtitleMode';

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function Overlay({
  entry,
  mode,
  position,
  durationSec,
  ratingEnabled,
  onRate,
  onClose,
}: {
  entry: Entry;
  mode: ReviewMode;
  position: ReviewPosition;
  durationSec: number;
  ratingEnabled: boolean;
  onRate: (rating: Rating) => void;
  onClose: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [paused, setPaused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(query.matches);
    const onChange = (event: MediaQueryListEvent) => setReducedMotion(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (hovered || paused) return;
    const timer = setTimeout(onClose, durationSec * 1000);
    return () => clearTimeout(timer);
  }, [hovered, paused, durationSec, onClose]);

  // The design degrades the moving barrage to the static subtitle bar when
  // the page asks for reduced motion; a translation that runs off-screen
  // without animating would never be readable.
  const effectiveMode: ReviewMode = mode === 'barrage' && reducedMotion ? 'subtitle' : mode;

  return (
    <div
      className={`ww-overlay ww-overlay-${effectiveMode}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {effectiveMode === 'subtitle' && (
        <SubtitleMode
          entry={entry}
          position={position}
          expanded={hovered}
          durationSec={durationSec}
          onRate={ratingEnabled ? onRate : onClose}
        />
      )}
      {effectiveMode === 'barrage' && (
        <BarrageMode
          entry={entry}
          onRate={ratingEnabled ? onRate : onClose}
          onPausedChange={setPaused}
          onDone={onClose}
        />
      )}
      {effectiveMode === 'card' && (
        <CardMode
          entry={entry}
          position={position}
          onRate={ratingEnabled ? onRate : onClose}
          onClose={onClose}
        />
      )}
      {effectiveMode !== 'card' && (
        <button
          type="button"
          className="ww-skip"
          onClick={onClose}
          aria-label="跳过本次复习"
        >
          跳过
        </button>
      )}
    </div>
  );
}
