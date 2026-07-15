export type ScheduledTask = unknown;

export interface MonitorClock {
  now(): number;
  setTimeout(callback: () => void | Promise<void>, delayMs: number): ScheduledTask;
  clearTimeout(task: ScheduledTask): void;
}

export const systemMonitorClock: MonitorClock = {
  now: Date.now,
  setTimeout(callback, delayMs) {
    return setTimeout(() => void callback(), delayMs);
  },
  clearTimeout(task) {
    clearTimeout(task as NodeJS.Timeout);
  },
};
