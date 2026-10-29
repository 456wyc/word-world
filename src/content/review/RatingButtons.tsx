import type { Rating } from '../../shared/types';

export function RatingButtons({ onRate }: { onRate: (rating: Rating) => void }) {
  return (
    <div className="ww-rating">
      <button type="button" className="ww-rate ww-known" onClick={() => onRate('known')}>
        认识
      </button>
      <button type="button" className="ww-rate ww-unsure" onClick={() => onRate('unsure')}>
        模糊
      </button>
      <button type="button" className="ww-rate ww-unknown" onClick={() => onRate('unknown')}>
        不认识
      </button>
    </div>
  );
}
