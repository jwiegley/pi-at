import type { AtClock } from "../../index.ts";

type Timer = { at: number; callback: () => void };

/** Timers run on elapsed time; sleep() moves only the wall clock, as a suspended laptop does. */
export class FakeClock implements AtClock {
  wall: number;
  elapsed = 0;
  timers: Timer[] = [];

  constructor(start: number) {
    this.wall = start;
  }

  now(): number {
    return this.wall;
  }

  schedule(callback: () => void, delayMs: number): () => void {
    const timer = { at: this.elapsed + Math.max(0, delayMs), callback };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((candidate) => candidate !== timer);
    };
  }

  /** Move both clocks forward, running timers in order, including ones armed along the way. */
  advance(ms: number): void {
    const end = this.elapsed + ms;
    for (;;) {
      const next = this.timers.reduce<Timer | undefined>(
        (earliest, timer) => (earliest === undefined || timer.at < earliest.at ? timer : earliest),
        undefined,
      );
      if (next === undefined || next.at > end) break;
      this.timers = this.timers.filter((timer) => timer !== next);
      this.wall += next.at - this.elapsed;
      this.elapsed = next.at;
      next.callback();
    }
    this.wall += end - this.elapsed;
    this.elapsed = end;
  }

  sleep(ms: number): void {
    this.wall += ms;
  }
}
