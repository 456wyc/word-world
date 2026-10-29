import { useEffect, useState } from 'react';
import { sendToBackground } from '../shared/messages';
import type { Entry, Settings, Stats } from '../shared/types';
import { hostFromUrl } from '../shared/utils';

const RECENT_LIMIT = 7;

export function App() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [words, setWords] = useState<Entry[]>([]);
  const [dueCount, setDueCount] = useState(0);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [host, setHost] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    const [statsResult, wordsResult, dueResult, settingsResult, tabs] = await Promise.all([
      sendToBackground<Stats>({ type: 'stats:get', payload: {} }),
      sendToBackground<Entry[]>({ type: 'words:list', payload: { sort: 'created' } }),
      sendToBackground<Entry[]>({ type: 'words:list', payload: { dueOnly: true } }),
      sendToBackground<Settings>({ type: 'settings:get', payload: {} }),
      chrome.tabs.query({ active: true, currentWindow: true }),
    ]);
    if (statsResult.ok) setStats(statsResult.data);
    if (wordsResult.ok) setWords(wordsResult.data.slice(0, RECENT_LIMIT));
    if (dueResult.ok) setDueCount(dueResult.data.length);
    if (settingsResult.ok) setSettings(settingsResult.data);
    setHost(hostFromUrl(tabs[0]?.url));
  }

  async function toggleReview(next: boolean) {
    const result = await sendToBackground<Settings>({
      type: 'settings:update',
      payload: { review: { enabled: next } },
    });
    if (result.ok) setSettings(result.data);
  }

  async function togglePauseSite(next: boolean) {
    if (!settings || !host) return;
    const pausedHosts = next
      ? Array.from(new Set([...settings.review.pausedHosts, host]))
      : settings.review.pausedHosts.filter((item) => item !== host);
    const result = await sendToBackground<Settings>({
      type: 'settings:update',
      payload: { review: { pausedHosts } },
    });
    if (result.ok) setSettings(result.data);
  }

  const paused = Boolean(host && settings?.review.pausedHosts.includes(host));

  return (
    <div className="ww-popup">
      <header className="ww-popup-head">
        <h1>Word World</h1>
        <span className="ww-badge">{stats ? `待复习 ${dueCount}` : '…'}</span>
      </header>

      <div className="ww-stats">
        <div>
          <strong>{stats?.reviewed ?? 0}</strong>
          <span>今日已复习</span>
        </div>
        <div>
          <strong>{stats?.added ?? 0}</strong>
          <span>今日新增</span>
        </div>
      </div>

      <div className="ww-row">
        <span>复习浮层</span>
        <label className="ww-switch">
          <input
            type="checkbox"
            checked={settings?.review.enabled ?? false}
            onChange={(event) => void toggleReview(event.target.checked)}
          />
          <span />
        </label>
      </div>

      <div className="ww-row">
        <span title={host ?? ''}>{host ? `在本站暂停（${host}）` : '在本站暂停'}</span>
        <label className="ww-switch">
          <input
            type="checkbox"
            disabled={!host || !settings}
            checked={paused}
            onChange={(event) => void togglePauseSite(event.target.checked)}
          />
          <span />
        </label>
      </div>

      <h2 className="ww-subhead">最近收录</h2>
      <ul className="ww-recent">
        {words.length === 0 && <li className="ww-empty">还没有收录，去网页上划词试试。</li>}
        {words.map((entry) => (
          <li key={entry.id}>
            <span className="ww-recent-word">{entry.text}</span>
            <span className="ww-recent-translation">{entry.translation}</span>
          </li>
        ))}
      </ul>

      <footer className="ww-popup-actions">
        <button
          className="ww-btn"
          onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL('manager.html') })}
        >
          生词本
        </button>
        <button className="ww-btn" onClick={() => chrome.runtime.openOptionsPage()}>
          设置
        </button>
      </footer>
    </div>
  );
}
