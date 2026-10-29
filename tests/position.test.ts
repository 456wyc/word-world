import { describe, expect, it } from 'vitest';
import { computeCardPosition } from '../src/content/selection/position';

const viewport = { width: 1000, height: 800 };
const size = { width: 320, height: 220 };

describe('computeCardPosition', () => {
  it('空间足够时放在选区下方', () => {
    const pos = computeCardPosition({ top: 100, bottom: 120, left: 200, right: 300 }, viewport, size);
    expect(pos.placement).toBe('below');
    expect(pos.top).toBe(128);
    expect(pos.left).toBe(200);
  });

  it('下方空间不足时翻转到上方', () => {
    const pos = computeCardPosition({ top: 700, bottom: 720, left: 200, right: 300 }, viewport, size);
    expect(pos.placement).toBe('above');
    expect(pos.top).toBe(700 - 8 - size.height);
  });

  it('左右越界时向内收', () => {
    const pos = computeCardPosition({ top: 100, bottom: 120, left: 950, right: 990 }, viewport, size);
    expect(pos.left).toBe(1000 - size.width - 8);
  });

  it('左侧越界时贴左边距', () => {
    const pos = computeCardPosition({ top: 100, bottom: 120, left: -20, right: 10 }, viewport, size);
    expect(pos.placement).toBe('below');
    expect(pos.left).toBe(8);
  });

  it('上下都放不下时贴底', () => {
    const pos = computeCardPosition({ top: 200, bottom: 700, left: 100, right: 200 }, viewport, size);
    expect(pos.top).toBe(800 - size.height - 8);
    expect(pos.placement).toBe('above');
  });
});
