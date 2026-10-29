import { useEffect, useState } from 'react';
import type { Entry, Rating } from '../../shared/types';
import { RatingButtons } from './RatingButtons';

export function BarrageMode({
  entry,
  onRate,
  onPausedChange,
  onDone,
}: {
  entry: Entry;
  onRate: (rating: Rating) => void;
  onPausedChange: (paused: boolean) => void;
  onDone: () => void;
}) {
  const [paused, setPaused] = useState(false);
  const duration = Math.max(6, Math.min(18, entry.text.length * 0.3 + 6));

  useEffect(() => {
    onPausedChange(paused);
  }, [paused, onPausedChange]);

  return (
    <div
      className="ww-barrage"
      style={{
        animationDuration: `${duration}s`,
        animationPlayState: paused ? 'paused' : 'running',
      }}
      onClick={() => setPaused(true)}
      onAnimationEnd={onDone}
    >
      <strong>{entry.text}</strong>
      <span>{entry.translation}</span>
      {paused && (
        <div className="ww-barrage-actions" onClick={(event) => event.stopPropagation()}>
          <RatingButtons onRate={onRate} />
        </div>
      )}
    </div>
  );
}
