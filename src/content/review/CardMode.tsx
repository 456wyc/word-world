import type { Entry, Rating, ReviewPosition } from '../../shared/types';
import { RatingButtons } from './RatingButtons';

export function CardMode({
  entry,
  position,
  onRate,
  onClose,
}: {
  entry: Entry;
  position: ReviewPosition;
  onRate: (rating: Rating) => void;
  onClose: () => void;
}) {
  return (
    <div className={`ww-cardmode ww-${position}`}>
      <div className="ww-cardmode-head">
        <div>
          <strong className="ww-word">{entry.text}</strong>
          {entry.phonetic && <span className="ww-phonetic">{entry.phonetic}</span>}
        </div>
        <button
          type="button"
          className="ww-icon-btn"
          title="关闭"
          aria-label="关闭"
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      {entry.senses?.slice(0, 2).map((sense, index) => (
        <div key={index} className="ww-cardmode-sense">
          {sense.pos ? <span className="ww-pos">{sense.pos}</span> : null}
          {sense.def}
        </div>
      ))}
      {entry.example && <p className="ww-example">{entry.example}</p>}
      {entry.translation && <div className="ww-translation">{entry.translation}</div>}
      <RatingButtons onRate={onRate} />
    </div>
  );
}
