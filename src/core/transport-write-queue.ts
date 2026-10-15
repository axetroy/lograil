import type { LogEntry } from '../types.js';
import type { Transport } from '../transport/transport.js';

export class TransportWriteQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  constructor(
    private readonly writeTimeoutMs: number,
    private readonly reportError: (
      error: unknown,
      entry: LogEntry,
      handler?: Transport['onError'],
    ) => void,
  ) {}

  get depth(): number {
    return this.pending;
  }

  write(
    transport: Transport,
    entry: LogEntry,
    formatted: string,
    limit: number,
  ): void {
    if (limit > 0 && this.pending + 1 > limit) {
      transport.onOverflow?.(entry, this.pending + 1);
      this.reportError(new Error(`queue full (depth ${this.pending + 1} > ${limit})`), entry);
      return;
    }

    if (this.pending > 0) {
      void this.append(() => this.performWrite(transport, entry, formatted));
      return;
    }

    const result = this.invokeWrite(transport, entry, formatted);
    if (!result) return;

    void this.append(async () => {
      try {
        await this.guardWrite(result);
      } catch (err) {
        this.reportError(err, entry, transport.onError);
      }
    });
  }

  append(action: () => void | Promise<void>): Promise<void> {
    this.pending += 1;
    const task = this.tail.then(action);
    this.tail = task.then(
      () => undefined,
      () => undefined,
    );
    void task.then(
      () => this.finishTask(),
      () => this.finishTask(),
    );
    return this.tail;
  }

  drain(): Promise<void> {
    return this.tail;
  }

  private async performWrite(transport: Transport, entry: LogEntry, formatted: string): Promise<void> {
    const result = this.invokeWrite(transport, entry, formatted);
    if (!result) return;
    try {
      await this.guardWrite(result);
    } catch (err) {
      this.reportError(err, entry, transport.onError);
    }
  }

  private invokeWrite(
    transport: Transport,
    entry: LogEntry,
    formatted: string,
  ): Promise<void> | undefined {
    try {
      const result = transport.write(entry, formatted);
      if (result && typeof (result as Promise<void>).then === 'function') {
        return Promise.resolve(result);
      }
    } catch (err) {
      this.reportError(err, entry, transport.onError);
    }
    return undefined;
  }

  private guardWrite(promise: Promise<void>): Promise<void> {
    if (!this.writeTimeoutMs) return promise;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`transport write timed out after ${this.writeTimeoutMs}ms`)),
        this.writeTimeoutMs,
      );
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  private finishTask(): void {
    this.pending -= 1;
  }
}
