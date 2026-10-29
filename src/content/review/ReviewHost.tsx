import { useCallback, useEffect, useRef, useState } from 'react';
import { RECENT_SHOWN_LIMIT, SKIP_RETRY_MS, STORAGE_KEYS } from '../../shared/constants';
import { sendToBackground } from '../../shared/messages';
import type { Entry, PublicSettings, Rating, ReviewMode } from '../../shared/types';
import { formatNextReview } from '../../shared/utils';
import { startScheduler } from '../scheduler';
import { uiState } from '../uiState';
import { Overlay } from './Overlay';
import { onPreview } from './preview';
import { PREVIEW_SAMPLE } from './sample';
import { shouldSkipPage } from './skip';

const TOAST_MS = 1500;

export function ReviewHost() {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [entry, setEntry] = useState<Entry | null>(null);
  const [previewMode, setPreviewMode] = useState<ReviewMode | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const recentRef = useRef<string[]>([]);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const ratingRef = useRef(false);
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const showNextRef = useRef<(() => Promise<boolean>) | null>(null);

  const loadSettings = useCallback(async () => {
    try {
      const result = await sendToBackground<PublicSettings>({
        type: 'settings:public',
        payload: {},
      });
      if (mountedRef.current && result.ok) setSettings(result.data);
    } catch {
      // Leave the review layer unmounted. Retrying automatically here would
      // hammer a dead service worker; the next page load or settings change
      // is the retry point.
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void loadSettings();
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes[STORAGE_KEYS.settings]) void loadSettings();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      mountedRef.current = false;
      uiState.overlayOpen = false;
      clearTimeout(toastTimer.current);
      clearTimeout(retryTimer.current);
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, [loadSettings]);

  const close = useCallback(() => {
    setEntry(null);
    setPreviewing(false);
    setPreviewMode(null);
    uiState.overlayOpen = false;
  }, []);

  const showToast = useCallback((text: string) => {
    if (!mountedRef.current) return;
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => {
      toastTimer.current = undefined;
      if (mountedRef.current) setToast(null);
    }, TOAST_MS);
  }, []);

  // Preview is purely local: it never calls review:next/rate, so it neither
  // bumps `stats.shown` nor changes SRS state. Ratings close instead of save.
  useEffect(() => {
    return onPreview((mode) => {
      setPreviewMode(mode);
      setPreviewing(true);
      setEntry(PREVIEW_SAMPLE);
      uiState.overlayOpen = true;
    });
  }, []);

  const fetchReview = useCallback(async (): Promise<Entry | null> => {
    if (inFlightRef.current) return null;
    inFlightRef.current = true;
    try {
      const result = await sendToBackground<Entry | null>({
        type: 'review:next',
        payload: { host: location.hostname, recentIds: recentRef.current },
      });
      if (!result.ok || !result.data) return null;
      recentRef.current = [result.data.id, ...recentRef.current].slice(
        0,
        RECENT_SHOWN_LIMIT,
      );
      return result.data;
    } catch {
      return null;
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  const showNext = useCallback(async (): Promise<boolean> => {
    if (uiState.overlayOpen) return false;
    const next = await fetchReview();
    if (!next || !mountedRef.current) return false;
    setEntry(next);
    uiState.overlayOpen = true;
    return true;
  }, [fetchReview]);

  useEffect(() => {
    showNextRef.current = showNext;
  }, [showNext]);

  const scheduleRetry = useCallback(() => {
    if (!mountedRef.current) return;
    clearTimeout(retryTimer.current);
    retryTimer.current = setTimeout(() => {
      retryTimer.current = undefined;
      if (!mountedRef.current || uiState.overlayOpen) return;
      void showNextRef.current?.();
    }, SKIP_RETRY_MS);
  }, []);

  useEffect(() => {
    clearTimeout(retryTimer.current);
    retryTimer.current = undefined;
    if (!settings) return;
    if (
      !settings.review.enabled ||
      settings.review.pausedHosts.includes(location.hostname)
    ) {
      setEntry(null);
      setPreviewing(false);
      setPreviewMode(null);
      uiState.overlayOpen = false;
      return;
    }

    return startScheduler({
      intervalSec: settings.review.intervalSec,
      shouldSkip: () => shouldSkipPage() || uiState.cardOpen || uiState.overlayOpen,
      onFire: showNext,
    });
  }, [settings, showNext]);

  const rate = useCallback(
    async (rating: Rating) => {
      const current = entry;
      if (!current || ratingRef.current) return;
      if (previewing) {
        close();
        return;
      }
      ratingRef.current = true;
      try {
        const result = await sendToBackground<{ entry: Entry; dueAt: number }>({
          type: 'review:rate',
          payload: { id: current.id, rating },
        });
        if (!mountedRef.current) return;
        if (result.ok) {
          showToast(`已记录 · ${formatNextReview(result.data.dueAt, Date.now())}`);
        } else {
          // Dismiss quietly; the next attempt waits SKIP_RETRY_MS.
          scheduleRetry();
        }
      } catch {
        if (mountedRef.current) scheduleRetry();
      } finally {
        ratingRef.current = false;
        if (mountedRef.current) close();
      }
    },
    [entry, previewing, close, showToast, scheduleRetry],
  );

  const review = settings?.review;
  const mode = previewMode ?? review?.displayMode ?? 'subtitle';
  if (!settings && !previewing) return null;

  return (
    <>
      {entry && (
        <Overlay
          entry={entry}
          mode={mode}
          position={review?.position ?? 'bottom'}
          durationSec={review?.durationSec ?? 8}
          ratingEnabled={!previewing}
          onRate={rate}
          onClose={close}
        />
      )}
      {toast && (
        <div className="ww-toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
    </>
  );
}
