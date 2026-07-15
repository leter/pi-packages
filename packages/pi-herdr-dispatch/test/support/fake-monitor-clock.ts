import type { MonitorClock, ScheduledTask } from "../../src/monitor/clock.js";

interface FakeTask {
  id: number;
  at: number;
  callback: () => void | Promise<void>;
  cancelled: boolean;
}

export class FakeMonitorClock implements MonitorClock {
  #now: number;
  #nextId = 1;
  readonly #tasks: FakeTask[] = [];

  constructor(now = 0) {
    this.#now = now;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void | Promise<void>, delayMs: number): ScheduledTask {
    if (!Number.isSafeInteger(delayMs) || delayMs < 0) throw new RangeError("invalid fake delay");
    const task: FakeTask = {
      id: this.#nextId++,
      at: this.#now + delayMs,
      callback,
      cancelled: false,
    };
    this.#tasks.push(task);
    return task;
  }

  clearTimeout(value: ScheduledTask): void {
    const task = value as FakeTask;
    task.cancelled = true;
  }

  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    while (true) {
      const task = this.#tasks
        .filter((candidate) => !candidate.cancelled && candidate.at <= target)
        .sort((left, right) => left.at - right.at || left.id - right.id)[0];
      if (!task) break;
      task.cancelled = true;
      this.#now = task.at;
      await task.callback();
      await Promise.resolve();
    }
    this.#now = target;
    await Promise.resolve();
  }

  pendingCount(): number {
    return this.#tasks.filter((task) => !task.cancelled).length;
  }
}
