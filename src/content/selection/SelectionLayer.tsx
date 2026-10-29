import { useCallback, useEffect, useRef, useState } from 'react';
import { extractContext, isValidSelection, normalizeText } from '../../shared/utils';
import { uiState } from '../uiState';
import { LookupCard, type CardRequest } from './LookupCard';
import type { Rect } from './position';

interface TriggerState extends CardRequest {
  key: number;
}

const EDITABLE_SELECTOR =
  'input, textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';

/**
 * True when the event originated inside any Word World shadow host.
 * Must be called while the event is being dispatched: `composedPath()` is
 * empty once dispatch finished, so debounced handlers receive the result.
 */
function isInsideExtension(event: Event): boolean {
  return event
    .composedPath()
    .some((node) => node instanceof Element && node.getAttribute('data-ww-ui') === '1');
}

export function SelectionLayer() {
  const [trigger, setTrigger] = useState<Omit<TriggerState, 'key'> | null>(null);
  const [card, setCard] = useState<TriggerState | null>(null);
  const cardRef = useRef<TriggerState | null>(null);
  cardRef.current = card;

  const closeCard = useCallback(() => {
    setCard(null);
    uiState.cardOpen = false;
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const onMouseUp = (event: MouseEvent) => {
      clearTimeout(timer);
      // `composedPath()` is only readable during dispatch, so resolve it now
      // instead of inside the debounce callback.
      const insideExtension = isInsideExtension(event);
      timer = setTimeout(() => {
        if (insideExtension) return;
        if (cardRef.current || uiState.cardOpen || uiState.overlayOpen) return;

        const selection = window.getSelection();
        const rawText = selection?.toString() ?? '';
        if (!selection || selection.rangeCount === 0 || !isValidSelection(rawText)) {
          setTrigger(null);
          return;
        }

        const anchorNode = selection.anchorNode;
        const element =
          anchorNode?.nodeType === Node.ELEMENT_NODE
            ? (anchorNode as Element)
            : anchorNode?.parentElement ?? null;
        if (element?.closest(EDITABLE_SELECTOR)) {
          setTrigger(null);
          return;
        }

        const rect = selection.getRangeAt(0).getBoundingClientRect();
        const block = element?.closest('p, li, article, section, blockquote, div');
        const text = normalizeText(rawText);
        const anchor: Rect = {
          top: rect.top,
          bottom: rect.bottom,
          left: rect.left,
          right: rect.right,
        };
        setTrigger({
          text,
          anchor,
          context: extractContext(block?.textContent ?? '', text),
          sourceUrl: location.href,
          sourceTitle: document.title,
        });
      }, 150);
    };

    const onMouseDown = (event: MouseEvent) => {
      if (isInsideExtension(event)) return;
      // A click elsewhere must also cancel a pending (debounced) selection.
      clearTimeout(timer);
      setTrigger(null);
      closeCard();
    };

    const onSelectionChange = () => {
      const selection = window.getSelection();
      if ((!selection || selection.isCollapsed) && !cardRef.current) setTrigger(null);
    };

    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('selectionchange', onSelectionChange);
    };
  }, [closeCard]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setTrigger(null);
        closeCard();
      }
    };
    const onScroll = (event: Event) => {
      if (isInsideExtension(event)) return;
      setTrigger(null);
      closeCard();
    };
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [closeCard]);

  const openCard = () => {
    if (!trigger) return;
    setCard({ ...trigger, key: Date.now() });
    setTrigger(null);
    uiState.cardOpen = true;
  };

  return (
    <>
      {trigger && (
        <button
          className="ww-trigger"
          style={{
            left: Math.min(trigger.anchor.right + 6, window.innerWidth - 32),
            top: Math.min(trigger.anchor.bottom + 6, window.innerHeight - 32),
          }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={openCard}
          title="查词 / 翻译"
        >
          译
        </button>
      )}
      {card && <LookupCard key={card.key} request={card} onClose={closeCard} />}
    </>
  );
}
