import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { sendToBackground } from '../../shared/messages';
import type { ErrorCode, LookupResponse } from '../../shared/types';
import { computeCardPosition, type Rect } from './position';

export interface CardRequest {
  text: string;
  anchor: Rect;
  context: string;
  sourceUrl: string;
  sourceTitle: string;
}

type CardState =
  | { status: 'loading' }
  | { status: 'ready'; data: LookupResponse }
  | { status: 'error'; message: string; code: ErrorCode };

const INITIAL_SIZE = { width: 320, height: 220 };

export function LookupCard({
  request,
  onClose,
}: {
  request: CardRequest;
  onClose: () => void;
}) {
  const [state, setState] = useState<CardState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [size, setSize] = useState(INITIAL_SIZE);
  const ref = useRef<HTMLDivElement>(null);

  // Content height changes between loading/ready/error. Measure after every
  // commit so a flipped ('above') card keeps its gap instead of overlapping
  // the selection with a stale height.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    setSize((prev) =>
      Math.abs(prev.width - width) > 1 || Math.abs(prev.height - height) > 1
        ? { width, height }
        : prev,
    );
  });

  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    (async () => {
      const result = await sendToBackground<LookupResponse>({
        type: 'lookup',
        payload: {
          text: request.text,
          context: request.context,
          sourceUrl: request.sourceUrl,
          sourceTitle: request.sourceTitle,
        },
      });
      if (!alive) return;
      setState(
        result.ok
          ? { status: 'ready', data: result.data }
          : { status: 'error', message: result.error.message, code: result.error.code },
      );
    })();
    return () => {
      alive = false;
    };
  }, [request.text, request.context, request.sourceUrl, request.sourceTitle, attempt]);

  const position = computeCardPosition(
    request.anchor,
    { width: window.innerWidth, height: window.innerHeight },
    size,
  );

  const speak = (text: string) => {
    if (!('speechSynthesis' in window)) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    window.speechSynthesis.speak(utterance);
  };

  const copy = (text: string) => {
    // Clipboard API is unavailable on non-secure pages; stay silent then.
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  };

  const remove = async () => {
    if (state.status !== 'ready') return;
    await sendToBackground({ type: 'words:delete', payload: { id: state.data.entry.id } });
    onClose();
  };

  return (
    <div
      ref={ref}
      className="ww-card"
      style={{ top: position.top, left: position.left }}
      role="dialog"
      aria-label="查词结果"
    >
      {state.status === 'loading' && (
        <div className="ww-card-loading">
          <div className="ww-skeleton ww-skeleton-wide" />
          <div className="ww-skeleton" />
          <div className="ww-skeleton ww-skeleton-short" />
        </div>
      )}

      {state.status === 'error' && (
        <div className="ww-card-error">
          <div className="ww-error-title">查询失败</div>
          <p>{state.message}</p>
          <div className="ww-card-actions">
            <button className="ww-btn" onClick={() => setAttempt((value) => value + 1)}>
              重试
            </button>
            {state.code === 'CONFIG' && (
              <button className="ww-btn ww-btn-primary" onClick={() => chrome.runtime.openOptionsPage()}>
                去设置里配置 AI
              </button>
            )}
            <button className="ww-btn" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>
      )}

      {state.status === 'ready' && (
        <>
          <div className="ww-card-head">
            <div className="ww-word-row">
              <strong className="ww-word">{state.data.entry.text}</strong>
              {state.data.entry.phonetic && (
                <span className="ww-phonetic">{state.data.entry.phonetic}</span>
              )}
              {state.data.entry.kind === 'word' && (
                <button
                  className="ww-icon-btn"
                  title="发音"
                  onClick={() => speak(state.data.entry.text)}
                >
                  🔊
                </button>
              )}
            </div>
            <button className="ww-icon-btn" title="关闭" onClick={onClose}>
              ✕
            </button>
          </div>

          <div className="ww-meta-line">
            {state.data.entry.lookups > 1 && <span>已收录 · 第 {state.data.entry.lookups} 次查询</span>}
            {state.data.cached && <span>离线缓存</span>}
            {state.data.fallbackReason === 'ai-unconfigured' && (
              <button className="ww-link" onClick={() => chrome.runtime.openOptionsPage()}>
                AI 未配置，已用免费接口
              </button>
            )}
            {state.data.fallbackReason === 'ai-error' && <span>AI 失败，已回退免费接口</span>}
            {state.data.fallbackReason === 'rate-limit' && <span>AI 限流，已回退免费接口</span>}
          </div>

          {state.data.entry.senses?.length ? (
            <ul className="ww-senses">
              {state.data.entry.senses.map((sense, index) => (
                <li key={index}>
                  {sense.pos && <span className="ww-pos">{sense.pos}</span>}
                  {sense.def}
                </li>
              ))}
            </ul>
          ) : null}

          {state.data.entry.example && (
            <p className="ww-example">{state.data.entry.example}</p>
          )}

          {state.data.entry.translation && (
            <div className="ww-translation">{state.data.entry.translation}</div>
          )}

          <div className="ww-card-actions">
            <button
              className="ww-btn"
              onClick={() => copy(state.data.entry.translation || state.data.entry.text)}
            >
              复制
            </button>
            <button className="ww-btn ww-btn-danger" onClick={remove}>
              移出生词本
            </button>
          </div>
        </>
      )}
    </div>
  );
}
