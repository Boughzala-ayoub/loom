/** Wake journal consumers after a durable change. The timer is a deadline, not a poll. */
export class TaskEventGate {
  private listeners = new Set<() => void>();

  notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  /** `signal`: aborting it ends the wait with its reason, listener and timer gone. */
  waitUntil(ready: () => boolean, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (ready() || timeoutMs <= 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => finish(signal!.reason);
      const finish = (error?: unknown) => {
        this.listeners.delete(check);
        signal?.removeEventListener("abort", abort);
        if (timer !== undefined) clearTimeout(timer);
        if (error !== undefined) reject(error);
        else resolve();
      };
      const check = () => {
        try { if (ready()) finish(); }
        catch (error) { finish(error); }
      };
      this.listeners.add(check);
      signal?.addEventListener("abort", abort);
      timer = setTimeout(() => finish(), timeoutMs);
      check(); // Close the gap between the initial check and listener registration.
    });
  }
}
