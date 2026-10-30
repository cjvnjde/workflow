/** Bounded in-session read concurrency; queued work is discarded on cancellation. */
export class ToolConcurrency {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 8) throw new Error("Tool concurrency must be between 1 and 8");
  }
  private acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const start = () => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) { reject(signal.reason); return; }
        this.active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true; this.active--;
          this.waiting.shift()?.();
        });
      };
      const abort = () => {
        const index = this.waiting.indexOf(start);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(signal.reason);
      };
      if (this.active < this.limit) start();
      else { this.waiting.push(start); signal.addEventListener("abort", abort, { once: true }); }
    });
  }
  async run<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try { signal.throwIfAborted(); return await operation(); }
    finally { release(); }
  }
}
