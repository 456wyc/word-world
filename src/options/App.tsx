import { useEffect, useRef, useState } from 'react';
import { DEFAULT_SETTINGS } from '../shared/constants';
import { downloadJson, readJsonFile } from '../shared/files';
import { sendToBackground } from '../shared/messages';
import type { Entry, ExportBundle, ReviewMode, Settings, SettingsPatch } from '../shared/types';
import { localDateKey } from '../shared/utils';

const MODES: Array<{ value: ReviewMode; label: string; hint: string }> = [
  { value: 'subtitle', label: '字幕条', hint: '底部一行字幕，悬停展开' },
  { value: 'barrage', label: '弹幕', hint: '从右向左飘过，点击停住' },
  { value: 'card', label: '角落卡片', hint: '右下角卡片，信息最全' },
];

const MESSAGE_MS = 1200;

export function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [hostsText, setHostsText] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void (async () => {
      const result = await sendToBackground<Settings>({ type: 'settings:get', payload: {} });
      if (result.ok) {
        setSettings(result.data);
        setHostsText(result.data.review.pausedHosts.join('\n'));
      }
      setLoaded(true);
    })();
  }, []);

  async function save(patch: SettingsPatch) {
    const result = await sendToBackground<Settings>({ type: 'settings:update', payload: patch });
    if (result.ok) {
      setSettings(result.data);
      setMessage('已保存');
      setTimeout(() => setMessage(null), MESSAGE_MS);
    } else {
      setMessage(result.error.message);
    }
  }

  async function saveHosts() {
    const pausedHosts = hostsText
      .split('\n')
      .map((host) => host.trim())
      .filter(Boolean);
    await save({ review: { pausedHosts } });
  }

  async function testProvider() {
    setMessage('测试中…');
    const result = await sendToBackground<{ provider: string; sample: string }>({
      type: 'provider:test',
      payload: {},
    });
    setMessage(
      result.ok
        ? `连接成功（${result.data.provider}）：${result.data.sample}`
        : result.error.message,
    );
  }

  async function exportData() {
    const result = await sendToBackground<ExportBundle>({ type: 'words:export', payload: {} });
    if (!result.ok) {
      setMessage(result.error.message);
      return;
    }
    downloadJson(`word-world-${localDateKey(Date.now())}.json`, result.data);
  }

  async function importData(file: File) {
    try {
      const raw = await readJsonFile(file);
      const entries = Array.isArray((raw as { entries?: unknown })?.entries)
        ? (raw as { entries: Entry[] }).entries
        : null;
      if (!entries) {
        setMessage('文件格式不正确：缺少 entries');
        return;
      }
      const result = await sendToBackground<{ imported: number; skipped: number }>({
        type: 'words:import',
        payload: { entries, mode: 'merge' },
      });
      setMessage(
        result.ok
          ? `导入完成：成功 ${result.data.imported}，跳过 ${result.data.skipped}`
          : result.error.message,
      );
    } catch {
      setMessage('JSON 解析失败');
    }
  }

  async function clearAll() {
    if (!window.confirm('确定清空全部生词？此操作不可撤销，建议先导出。')) return;
    const result = await sendToBackground({ type: 'words:clear', payload: {} });
    setMessage(result.ok ? '已清空' : '清空失败');
  }

  async function preview() {
    const result = await sendToBackground<{ shown: boolean }>({
      type: 'review:preview',
      payload: { mode: settings.review.displayMode },
    });
    setMessage(result.ok ? '已发送预览到当前网页' : result.error.message);
  }

  if (!loaded) return <div className="ww-page">加载中…</div>;

  return (
    <div className="ww-page">
      <h1>Word World 设置</h1>
      {message && <div className="ww-message">{message}</div>}

      <section>
        <h2>数据源</h2>
        <div className="ww-field">
          <label>
            <input
              type="radio"
              name="provider-mode"
              checked={settings.provider.mode === 'free'}
              onChange={() => void save({ provider: { mode: 'free' } })}
            />
            免费接口（dictionaryapi + Google/MyMemory）
          </label>
        </div>
        <div className="ww-field">
          <label>
            <input
              type="radio"
              name="provider-mode"
              checked={settings.provider.mode === 'ai'}
              onChange={() => void save({ provider: { mode: 'ai' } })}
            />
            AI（OpenAI 兼容接口）
          </label>
        </div>

        <div className="ww-grid">
          <label>
            Base URL
            <input
              value={settings.provider.ai.baseUrl}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  provider: {
                    ...settings.provider,
                    ai: { ...settings.provider.ai, baseUrl: event.target.value },
                  },
                })
              }
            />
          </label>
          <label>
            API Key
            <input
              type="password"
              value={settings.provider.ai.apiKey}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  provider: {
                    ...settings.provider,
                    ai: { ...settings.provider.ai, apiKey: event.target.value },
                  },
                })
              }
            />
          </label>
          <label>
            模型
            <input
              value={settings.provider.ai.model}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  provider: {
                    ...settings.provider,
                    ai: { ...settings.provider.ai, model: event.target.value },
                  },
                })
              }
            />
          </label>
        </div>
        <div className="ww-actions">
          <button
            className="ww-btn ww-btn-primary"
            onClick={() => void save({ provider: { ai: settings.provider.ai } })}
          >
            保存 AI 配置
          </button>
          <button className="ww-btn" onClick={() => void testProvider()}>
            测试连接
          </button>
        </div>
      </section>

      <section>
        <h2>复习</h2>
        <div className="ww-field ww-inline">
          <label>
            <input
              type="checkbox"
              checked={settings.review.enabled}
              onChange={(event) => void save({ review: { enabled: event.target.checked } })}
            />
            启用网页复习浮层
          </label>
        </div>
        <div className="ww-field">
          <label>
            弹窗间隔：{settings.review.intervalSec} 秒
            <input
              type="range"
              min={60}
              max={1800}
              step={30}
              value={settings.review.intervalSec}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  review: { ...settings.review, intervalSec: Number(event.target.value) },
                })
              }
              onMouseUp={() => void save({ review: { intervalSec: settings.review.intervalSec } })}
              onTouchEnd={() => void save({ review: { intervalSec: settings.review.intervalSec } })}
            />
          </label>
        </div>
        <div className="ww-field">
          <span>浮层形态</span>
          <div className="ww-modes">
            {MODES.map((item) => (
              <button
                key={item.value}
                className={`ww-mode ${settings.review.displayMode === item.value ? 'ww-mode-active' : ''}`}
                onClick={() => void save({ review: { displayMode: item.value } })}
              >
                <strong>{item.label}</strong>
                <small>{item.hint}</small>
              </button>
            ))}
          </div>
        </div>
        <div className="ww-field ww-inline">
          <label>
            位置
            <select
              value={settings.review.position}
              onChange={(event) =>
                void save({ review: { position: event.target.value === 'top' ? 'top' : 'bottom' } })
              }
            >
              <option value="bottom">底部</option>
              <option value="top">顶部</option>
            </select>
          </label>
          <label>
            停留时长：{settings.review.durationSec} 秒
            <input
              type="range"
              min={4}
              max={30}
              value={settings.review.durationSec}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  review: { ...settings.review, durationSec: Number(event.target.value) },
                })
              }
              onMouseUp={() => void save({ review: { durationSec: settings.review.durationSec } })}
              onTouchEnd={() => void save({ review: { durationSec: settings.review.durationSec } })}
            />
          </label>
        </div>
        <div className="ww-actions">
          <button className="ww-btn" onClick={() => void preview()}>
            立即预览一次浮层
          </button>
        </div>
      </section>

      <section>
        <h2>暂停复习的站点</h2>
        <p className="ww-hint">每行一个域名，例如 news.ycombinator.com</p>
        <textarea
          rows={4}
          value={hostsText}
          onChange={(event) => setHostsText(event.target.value)}
          onBlur={() => void saveHosts()}
        />
      </section>

      <section>
        <h2>数据</h2>
        <div className="ww-actions">
          <button className="ww-btn" onClick={() => void exportData()}>
            导出 JSON
          </button>
          <button className="ww-btn" onClick={() => fileRef.current?.click()}>
            导入 JSON
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importData(file);
              event.target.value = '';
            }}
          />
          <button className="ww-btn ww-btn-danger" onClick={() => void clearAll()}>
            清空全部
          </button>
        </div>
      </section>
    </div>
  );
}
