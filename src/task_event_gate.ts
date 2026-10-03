/** Wake journal consumers after a durable change. The timer is a deadline, not a poll. */
export class TaskEventGate {
  private listeners = new Set<() => void>();

  notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  waitUntil(ready: () => boolean, timeoutMs: number): Promise<void> {
    if (ready() || timeoutMs <= 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: unknown) => {
        this.listeners.delete(check);
        if (timer !== undefined) clearTimeout(timer);
        if (error !== undefined) reject(error);
        else resolve();
      };
      const check = () => {
        try { if (ready()) finish(); }
        catch (error) { finish(error); }
      };
      this.listeners.add(check);
      timer = setTimeout(() => finish(), timeoutMs);
      check(); // Close the gap between the initial check and listener registration.
    });
  }
}
