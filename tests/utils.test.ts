import { describe, expect, it } from 'vitest';
import {
  classifySelection,
  containsCJK,
  extractContext,
  formatNextReview,
  hostFromUrl,
  isValidSelection,
  localDateKey,
  normalizeText,
  sanitizeHttpUrl,
} from '../src/shared/utils';

describe('normalizeText', () => {
  it('合并空白并去除首尾空格', () => {
    expect(normalizeText('  hello\n\t world  ')).toBe('hello world');
  });
});

describe('classifySelection', () => {
  it('单个英文单词判为 word', () => {
    expect(classifySelection(' hello ')).toBe('word');
  });

  it('两个英文单词判为 word', () => {
    expect(classifySelection('ice cream')).toBe('word');
  });

  it('带标点的句子判为 sentence', () => {
    expect(classifySelection('This is a sentence.')).toBe('sentence');
  });

  it('中文内容判为 sentence', () => {
    expect(classifySelection('你好世界')).toBe('sentence');
  });
});

describe('isValidSelection', () => {
  it('拒绝空字符串', () => {
    expect(isValidSelection('   ')).toBe(false);
  });

  it('拒绝超过 400 字符', () => {
    expect(isValidSelection('a'.repeat(401))).toBe(false);
  });
});

describe('formatNextReview', () => {
  const now = 1_000_000_000_000;

  it('小于一小时显示分钟', () => {
    expect(formatNextReview(now + 10 * 60_000, now)).toBe('10 分钟后');
  });

  it('整小时显示小时', () => {
    expect(formatNextReview(now + 60 * 60_000, now)).toBe('1 小时后');
  });

  it('多天显示天', () => {
    expect(formatNextReview(now + 3 * 86_400_000, now)).toBe('3 天后');
  });
});

describe('localDateKey', () => {
  it('输出 YYYY-MM-DD', () => {
    expect(localDateKey(new Date(2026, 0, 5, 12).getTime())).toBe('2026-01-05');
  });
});

describe('hostFromUrl / sanitizeHttpUrl', () => {
  it('提取合法 http(s) 主机名', () => {
    expect(hostFromUrl('https://example.com/a?b=1')).toBe('example.com');
  });

  it('拒绝 chrome:// 与非法 URL', () => {
    expect(hostFromUrl('chrome://extensions')).toBeNull();
    expect(hostFromUrl('not a url')).toBeNull();
  });

  it('sanitizeHttpUrl 只保留 http(s)', () => {
    expect(sanitizeHttpUrl('javascript:alert(1)')).toBeUndefined();
    expect(sanitizeHttpUrl('https://example.com/x')).toBe('https://example.com/x');
  });
});

describe('extractContext', () => {
  it('围绕选中词截取上下文', () => {
    const text = 'A quick brown fox jumps over the lazy dog near the river bank';
    const context = extractContext(text, 'fox', 30);
    expect(context).toContain('fox');
    expect(context.length).toBeLessThanOrEqual(30);
  });
});

describe('containsCJK', () => {
  it('识别中文', () => {
    expect(containsCJK('hello 世界')).toBe(true);
    expect(containsCJK('hello world')).toBe(false);
  });
});
