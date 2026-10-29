import { MAX_SELECTION_LENGTH, MAX_SENSES } from '../../shared/constants';
import { fetchJson, ProviderError } from '../../shared/http';
import type { EntryKind, LookupPayload, Sense, Settings } from '../../shared/types';

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

export function parseAiPayload(content: string): LookupPayload {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new ProviderError('NETWORK', 'AI 返回格式无效');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    throw new ProviderError('NETWORK', 'AI 返回格式无效');
  }
  const record = asRecord(parsed);

  const translation = record?.translation;
  if (typeof translation !== 'string' || !translation.trim()) {
    throw new ProviderError('NETWORK', 'AI 返回缺少译文');
  }

  let senses: Sense[] | undefined;
  const rawSenses = record?.senses;
  if (Array.isArray(rawSenses)) {
    const list: Sense[] = [];
    for (const item of rawSenses) {
      if (list.length >= MAX_SENSES) break;
      const sense = asRecord(item);
      if (!sense || typeof sense.def !== 'string' || !sense.def.trim()) continue;
      list.push({
        pos: typeof sense.pos === 'string' ? sense.pos : undefined,
        def: clamp(sense.def.trim(), MAX_SELECTION_LENGTH),
      });
    }
    if (list.length) senses = list;
  }

  return {
    translation: clamp(translation.trim(), MAX_SELECTION_LENGTH),
    phonetic: typeof record?.phonetic === 'string' ? record.phonetic : undefined,
    senses,
    example:
      typeof record?.example === 'string'
        ? clamp(record.example.trim(), MAX_SELECTION_LENGTH)
        : undefined,
  };
}

export async function aiLookup(
  text: string,
  kind: EntryKind,
  context: string | undefined,
  cfg: Settings['provider']['ai'],
): Promise<LookupPayload> {
  if (!cfg.apiKey) throw new ProviderError('CONFIG', '未配置 AI API Key');

  const userPrompt =
    kind === 'word'
      ? `查询英文单词：${text}\n${context ? `上下文：${context}\n` : ''}返回 JSON：{"translation":"中文释义","phonetic":"音标(可空)","senses":[{"pos":"n.","def":"中文释义"}],"example":"英文例句(可空)"}`
      : `把下面的内容翻译成中文（若原文为中文则翻译成英文）：${text}\n只返回 JSON：{"translation":"译文"}`;

  const data = await fetchJson<{ choices?: Array<{ message?: { content?: string } }> }>(
    `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: '只输出 JSON，不要任何解释或 markdown 代码围栏。' },
          { role: 'user', content: userPrompt },
        ],
      }),
    },
  );

  const content = data.choices?.[0]?.message?.content ?? '';
  return parseAiPayload(content);
}
