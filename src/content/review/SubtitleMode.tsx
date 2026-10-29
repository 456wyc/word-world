import type { Entry, Rating, ReviewPosition } from '../../shared/types';
import { RatingButtons } from './RatingButtons';

export function SubtitleMode({
  entry,
  position,
  expanded,
  durationSec,
  onRate,
}: {
  entry: Entry;
  position: ReviewPosition;
  expanded: boolean;
  durationSec: number;
  onRate: (rating: Rating) => void;
}) {
  return (
    <div className={`ww-subtitle ww-${position}`}>
      <div
        className="ww-progress"
        style={{
          animationDuration: `${durationSec}s`,
          animationPlayState: expanded ? 'paused' : 'running',
        }}
      />
      <div className="ww-subtitle-main">
        <strong>{entry.text}</strong>
        {entry.phonetic && <span className="ww-phonetic">{entry.phonetic}</span>}
        <span className="ww-subtitle-translation">{entry.translation}</span>
      </div>
      {expanded && (
        <div className="ww-subtitle-more">
          {entry.senses?.slice(0, 2).map((sense, index) => (
            <div key={index}>
              {sense.pos ? <span className="ww-pos">{sense.pos}</span> : null}
              {sense.def}
            </div>
          ))}
          {entry.example && <em>{entry.example}</em>}
          <RatingButtons onRate={onRate} />
        </div>
      )}
    </div>
  );
}
