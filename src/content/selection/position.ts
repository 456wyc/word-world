export interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface CardPosition {
  top: number;
  left: number;
  placement: 'above' | 'below';
}

export function computeCardPosition(
  anchor: Rect,
  viewport: Viewport,
  size: Size,
): CardPosition {
  const gap = 8;
  const margin = 8;
  const left = Math.min(
    Math.max(margin, anchor.left),
    Math.max(margin, viewport.width - size.width - margin),
  );
  const below = anchor.bottom + gap;
  const above = anchor.top - gap - size.height;

  if (below + size.height <= viewport.height - margin) {
    return { top: below, left, placement: 'below' };
  }
  if (above >= margin) {
    return { top: above, left, placement: 'above' };
  }
  return {
    top: Math.max(margin, viewport.height - size.height - margin),
    left,
    placement: 'above',
  };
}
