import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { downloadJson, readJsonFile } from '../shared/files';
import { sendToBackground } from '../shared/messages';
import type { Entry, EntryKind, ExportBundle, WordSort } from '../shared/types';
import { formatNextReview, hostFromUrl, localDateKey } from '../shared/utils';

type Filter = 'all' | 'due' | EntryKind;

const SEARCH_DEBOUNCE_MS = 300;

export function App() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<WordSort>('created');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const result = await sendToBackground<Entry[]>({
      type: 'words:list',
      payload: {
        query: query.trim() || undefined,
        kind: filter === 'word' || filter === 'sentence' ? filter : undefined,
        dueOnly: filter === 'due',
        sort,
      },
    });
    if (result.ok) setEntries(result.data);
    else setMessage(result.error.message);
  }, [query, filter, sort]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [load]);

  const dueCount = useMemo(
    () => entries.filter((entry) => entry.srs.dueAt <= Date.now()).length,
    [entries],
  );

  async function saveNote(entry: Entry, note: string) {
    const result = await sendToBackground<Entry>({
      type: 'words:update',
      payload: { id: entry.id, patch: { note } },
    });
    if (result.ok) {
      setEntries((list) => list.map((item) => (item.id === result.data.id ? result.data : item)));
    }
  }

  async function removeEntry(entry: Entry) {
    if (!window.confirm(`删除「${entry.text}」？`)) return;
    const result = await sendToBackground({ type: 'words:delete', payload: { id: entry.id } });
    if (result.ok) setEntries((list) => list.filter((item) => item.id !== entry.id));
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
      const data = raw as { entries?: Entry[] };
      if (!Array.isArray(data.entries)) {
        setMessage('文件格式不正确：缺少 entries');
        return;
      }
      const result = await sendToBackground<{ imported: number; skipped: number }>({
        type: 'words:import',
        payload: { entries: data.entries, mode: 'merge' },
      });
      if (result.ok) {
        setMessage(`导入完成：成功 ${result.data.imported}，跳过 ${result.data.skipped}`);
        await load();
      } else {
        setMessage(result.error.message);
      }
    } catch {
      setMessage('JSON 解析失败');
    }
  }

  async function clearAll() {
    if (!window.confirm('确定清空全部生词？此操作不可撤销，建议先导出。')) return;
    const result = await sendToBackground({ type: 'words:clear', payload: {} });
    if (result.ok) {
      setEntries([]);
      setMessage('已清空');
    }
  }

  return (
    <div className="ww-manager">
      <div className="ww-card">
        <header className="ww-manager-head">
          <div>
            <h1>生词本</h1>
            <p className="ww-hint">
              共 {entries.length} 条 · 待复习 {dueCount} 条
            </p>
          </div>
          <div className="ww-actions">
            <button className="ww-btn" onClick={() => void exportData()}>
              导出
            </button>
            <button className="ww-btn" onClick={() => fileRef.current?.click()}>
              导入
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
              清空
            </button>
          </div>
        </header>

        {message && <div className="ww-message">{message}</div>}

        <div className="ww-toolbar">
          <input
            className="ww-search"
            placeholder="搜索单词、释义或备注…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <select value={filter} onChange={(event) => setFilter(event.target.value as Filter)}>
            <option value="all">全部</option>
            <option value="word">单词</option>
            <option value="sentence">句子</option>
            <option value="due">待复习</option>
          </select>
          <select value={sort} onChange={(event) => setSort(event.target.value as WordSort)}>
            <option value="created">按创建时间</option>
            <option value="due">按到期时间</option>
            <option value="lookups">按查询次数</option>
          </select>
        </div>

        {entries.length === 0 ? (
          <div className="ww-empty-state">
            <p className="ww-empty-title">没有匹配的词条</p>
            <p className="ww-hint">去网页上划词查词，结果会自动收录到这里。</p>
          </div>
        ) : (
          <ul className="ww-list">
            {entries.map((entry) => {
              const isExpanded = expanded === entry.id;
              return (
                <li key={entry.id} className={`ww-item ${isExpanded ? 'ww-item-open' : ''}`}>
                  <EntryRow
                    entry={entry}
                    expanded={isExpanded}
                    onToggle={() => setExpanded(isExpanded ? null : entry.id)}
                    onSaveNote={(note) => void saveNote(entry, note)}
                    onDelete={() => void removeEntry(entry)}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function EntryRow({
  entry,
  expanded,
  onToggle,
  onSaveNote,
  onDelete,
}: {
  entry: Entry;
  expanded: boolean;
  onToggle: () => void;
  onSaveNote: (note: string) => void;
  onDelete: () => void;
}) {
  const [note, setNote] = useState(entry.note ?? '');
  useEffect(() => setNote(entry.note ?? ''), [entry.note]);

  const host = hostFromUrl(entry.sourceUrl);
  const due = entry.srs.dueAt <= Date.now();
  const stageLabel = entry.srs.stage === 0 ? '新词' : `阶段 ${entry.srs.stage}`;

  return (
    <>
      <div
        className="ww-item-main"
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onToggle();
          }
        }}
      >
        <div className="ww-item-top">
          <span className={`ww-kind ww-kind-${entry.kind}`}>
            {entry.kind === 'word' ? '词' : '句'}
          </span>
          <strong className="ww-item-word">{entry.text}</strong>
          <span className={`ww-due ${due ? 'ww-due-now' : ''}`}>
            {due ? '待复习' : formatNextReview(entry.srs.dueAt, Date.now())}
          </span>
          <span className="ww-chip">{stageLabel}</span>
          <span className="ww-chip">查 {entry.lookups} 次</span>
          {host && <span className="ww-host">{host}</span>}
          <button
            className="ww-del"
            onClick={(event) => {
              event.stopPropagation();
              onDelete();
            }}
          >
            删除
          </button>
        </div>
        <div className="ww-item-translation">{entry.translation || '—'}</div>
      </div>

      {expanded && (
        <div className="ww-item-detail">
          {entry.context && (
            <p>
              <span className="ww-detail-label">上下文</span>
              {entry.context}
            </p>
          )}
          {entry.example && (
            <p>
              <span className="ww-detail-label">例句</span>
              {entry.example}
            </p>
          )}
          {entry.sourceUrl && (
            <p>
              <span className="ww-detail-label">来源</span>
              <a href={entry.sourceUrl} target="_blank" rel="noreferrer">
                {entry.sourceTitle || entry.sourceUrl}
              </a>
            </p>
          )}
          <label className="ww-note">
            <span className="ww-detail-label">备注</span>
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              onBlur={() => onSaveNote(note)}
              placeholder="记点什么，方便以后回忆"
            />
          </label>
        </div>
      )}
    </>
  );
}
