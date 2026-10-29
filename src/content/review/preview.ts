import type { ReviewMode } from '../../shared/types';

type PreviewHandler = (mode: ReviewMode) => void;
const handlers = new Set<PreviewHandler>();

export function onPreview(handler: PreviewHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

export function emitPreview(mode: ReviewMode): void {
  handlers.forEach((handler) => handler(mode));
}
