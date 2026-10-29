import { SKIP_RETRY_MS } from '../shared/constants';

export interface SchedulerConfig {
  intervalSec: number;
  shouldSkip: () => boolean;
  onFire: () => Promise<boolean>;
  random?: () => number;
}

export function jitter(intervalSec: number, random: () => number = Math.random): number {
  const factor = 0.8 + random() * 0.4;
  return Math.max(1000, Math.round(intervalSec * 1000 * factor));
}

export function startScheduler(config: SchedulerConfig): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (delay: number) => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(tick, delay);
  };

  const tick = async () => {
    if (stopped) return;
    if (config.shouldSkip()) {
      schedule(SKIP_RETRY_MS);
      return;
    }
    let shown = false;
    try {
      shown = await config.onFire();
    } catch {
      shown = false;
    }
    schedule(shown ? jitter(config.intervalSec, config.random) : SKIP_RETRY_MS);
  };

  schedule(jitter(config.intervalSec, config.random));
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
