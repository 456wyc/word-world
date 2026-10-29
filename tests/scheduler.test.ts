import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jitter, startScheduler } from '../src/content/scheduler';

describe('jitter', () => {
  it('随机数 0.5 时不抖动', () => {
    expect(jitter(60, () => 0.5)).toBe(60_000);
  });

  it('浮动范围在 ±20% 内', () => {
    expect(jitter(60, () => 0)).toBe(48_000);
    expect(jitter(60, () => 1)).toBe(72_000);
  });

  it('不低于 1 秒', () => {
    expect(jitter(1, () => 0)).toBe(1000);
  });
});

describe('startScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('到期后触发 onFire', async () => {
    const onFire = vi.fn(async () => true);
    const stop = startScheduler({
      intervalSec: 60,
      shouldSkip: () => false,
      onFire,
      random: () => 0.5,
    });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(onFire).toHaveBeenCalledTimes(1);
    stop();
  });

  it('跳过条件成立时延迟重试且不触发', async () => {
    const onFire = vi.fn(async () => true);
    const stop = startScheduler({
      intervalSec: 60,
      shouldSkip: () => true,
      onFire,
      random: () => 0.5,
    });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(onFire).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(onFire).not.toHaveBeenCalled();
    stop();
  });

  it('stop 后不再触发', async () => {
    const onFire = vi.fn(async () => true);
    const stop = startScheduler({
      intervalSec: 60,
      shouldSkip: () => false,
      onFire,
      random: () => 0.5,
    });
    stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onFire).not.toHaveBeenCalled();
  });
});
