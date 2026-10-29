import { MAX_SENSES } from '../../shared/constants';
import { fetchJson, ProviderError } from '../../shared/http';
import type { EntryKind, LookupPayload, Sense } from '../../shared/types';
import { containsCJK } from '../../shared/utils';

interface DictEntry {
  word?: string;
  phonetic?: string;
  phonetics?: Array<{ text?: string }>;
  meanings?: Array<{
    partOfSpeech?: string;
    definitions?: Array<{ definition: string; example?: string }>;
  }>;
}

async function dictionaryLookup(word: string): Promise<Partial<LookupPayload>> {
  const data = await fetchJson<DictEntry[]>(
    `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`,
  );
  const first = Array.isArray(data) ? data[0] : undefined;
  if (!first) throw new ProviderError('NETWORK', '未找到释义');

  const phonetic = first.phonetic || first.phonetics?.find((item) => item.text)?.text;
  const senses: Sense[] = [];
  let example: string | undefined;

  for (const meaning of first.meanings ?? []) {
    for (const definition of meaning.definitions ?? []) {
      if (senses.length >= MAX_SENSES) break;
      senses.push({ pos: meaning.partOfSpeech, def: definition.definition });
      example ??= definition.example;
    }
    if (senses.length >= MAX_SENSES) break;
  }
  if (!senses.length) throw new ProviderError('NETWORK', '未找到释义');
  return { phonetic, senses, example };
}

async function googleTranslate(text: string, target: string): Promise<string> {
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx' +
    `&sl=auto&tl=${target}&dt=t&q=${encodeURIComponent(text)}`;
  const data = await fetchJson<unknown[]>(url);
  const segments = Array.isArray(data?.[0]) ? (data[0] as unknown[][]) : [];
  const translated = segments.map((segment) => segment?.[0] ?? '').join('');
  if (!translated.trim()) throw new ProviderError('NETWORK', '翻译结果为空');
  return translated;
}

async function myMemoryTranslate(text: string, source: string, target: string): Promise<string> {
  const url =
    'https://api.mymemory.translated.net/get' +
    `?q=${encodeURIComponent(text.slice(0, 500))}&langpair=${source}|${target}`;
  const data = await fetchJson<{
    responseStatus?: number;
    responseData?: { translatedText?: string };
  }>(url);
  const translated = data.responseData?.translatedText?.trim();
  if (!translated || data.responseStatus !== 200) {
    throw new ProviderError('RATE_LIMIT', '翻译接口限流，请稍后再试');
  }
  return translated;
}

export async function translateText(text: string): Promise<string> {
  const target = containsCJK(text) ? 'en' : 'zh-CN';
  const source = target === 'en' ? 'zh-CN' : 'en';
  try {
    return await googleTranslate(text, target);
  } catch {
    return myMemoryTranslate(text, source, target);
  }
}

export async function freeLookup(text: string, kind: EntryKind): Promise<LookupPayload> {
  let dictionary: Partial<LookupPayload> = {};
  let dictionaryError: unknown;
  if (kind === 'word') {
    try {
      dictionary = await dictionaryLookup(text);
    } catch (error) {
      dictionaryError = error;
    }
  }

  let translation = '';
  let translateError: unknown;
  try {
    translation = await translateText(text);
  } catch (error) {
    translateError = error;
  }

  if (!translation && !dictionary.senses?.length) {
    if (translateError instanceof ProviderError) throw translateError;
    if (dictionaryError instanceof ProviderError) throw dictionaryError;
    throw new ProviderError('NETWORK', '查询失败，请稍后重试');
  }

  return { translation, ...dictionary };
}
