export type StreamControllerState = 'open' | 'closed' | 'aborted';

/** Fixed-rate typewriter pacing for a Markdown stream. */
export interface StreamPacingOptions {
  /** Visible grapheme clusters committed per second. */
  graphemesPerSecond: number;
}

/** Options for {@link StreamController}. */
export interface StreamControllerOptions {
  /** Accepted UTF-16 code units before one producer write is backpressured. */
  maxBufferedChars?: number;
  /** Omit for performance-only animation-frame batching. */
  pacing?: StreamPacingOptions;
  /** Aborts and discards uncommitted text when signalled. */
  signal?: AbortSignal;
}

/** A frame-coalesced, lifecycle-bound writer for one Markdown instance. */
export interface StreamController {
  readonly state: StreamControllerState;
  /** Accepted plus blocked UTF-16 code units not yet committed. */
  readonly bufferedChars: number;
  /** Resolve when this chunk enters the bounded controller buffer. */
  write(chunk: string): Promise<void>;
  /** Synchronously commit every submitted chunk without closing. */
  flush(): void;
  /** Synchronously final-flush, then resolve after the controller closes. */
  close(): Promise<void>;
  /** Discard uncommitted text and reject pending/future operations. */
  abort(reason?: unknown): void;
  /** Abort and release every scheduler/listener owned by this controller. */
  destroy(): void;
}

/** @internal Host operations supplied by Markdown. */
export interface MarkdownStreamHost {
  append(chunk: string): void;
  release(controller: BoundStreamController): void;
}

/** @internal The controller shape retained by Markdown. */
export type BoundStreamController = StreamController;

const DEFAULT_MAX_BUFFERED_CHARS = 64 * 1024;
const MAX_FRAME_DELTA_MS = 100;
const MIN_SCAN_CODE_UNITS = 64;

interface BlockedWrite {
  chunk: string;
  resolve: () => void;
  reject: (reason?: unknown) => void;
}

interface GraphemePrefix {
  text: string;
  count: number;
  codeUnits: number;
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite number`);
  }
  return value;
}

function abortError(): Error {
  const error = new Error('Stream aborted');
  error.name = 'AbortError';
  return error;
}

class StreamControllerImpl implements BoundStreamController {
  private readonly maxBufferedChars: number;
  private readonly graphemesPerSecond: number | null;
  private readonly segmenter: Intl.Segmenter | null;
  private readonly signal?: AbortSignal;
  private readonly onSignalAbort: () => void;
  private chunks: string[] = [];
  private headIndex = 0;
  private headOffset = 0;
  private acceptedChars = 0;
  private blocked: BlockedWrite | null = null;
  private currentState: StreamControllerState = 'open';
  private terminalReason: unknown = null;
  private rafId: number | null = null;
  private lastFrameAt: number | null = null;
  private graphemeCredit = 0;
  private released = false;
  private closePromise: Promise<void> | null = null;
  private resolveClose: (() => void) | null = null;
  private rejectClose: ((reason?: unknown) => void) | null = null;

  public constructor(
    private readonly host: MarkdownStreamHost,
    options: StreamControllerOptions,
  ) {
    this.maxBufferedChars = positiveFinite(
      options.maxBufferedChars ?? DEFAULT_MAX_BUFFERED_CHARS,
      'maxBufferedChars',
    );
    this.graphemesPerSecond = options.pacing
      ? positiveFinite(options.pacing.graphemesPerSecond, 'pacing.graphemesPerSecond')
      : null;
    this.segmenter =
      this.graphemesPerSecond === null
        ? null
        : new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    this.signal = options.signal;
    this.onSignalAbort = () => this.abort(this.signal?.reason);

    if (this.signal?.aborted) this.abort(this.signal.reason);
    else this.signal?.addEventListener('abort', this.onSignalAbort, { once: true });
  }

  public get state(): StreamControllerState {
    return this.currentState;
  }

  public get bufferedChars(): number {
    return this.acceptedChars + (this.blocked?.chunk.length ?? 0);
  }

  public write(chunk: string): Promise<void> {
    if (this.currentState !== 'open' || this.closePromise) {
      return Promise.reject(this.reasonForWrite());
    }
    if (chunk.length === 0) return Promise.resolve();
    if (this.blocked) {
      return Promise.reject(new Error('StreamController already has a blocked write'));
    }

    if (this.canAdmit(chunk)) {
      this.admit(chunk);
      try {
        this.schedule();
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error);
      }
    }

    return new Promise<void>((resolve, reject) => {
      const blocked = { chunk, resolve, reject };
      this.blocked = blocked;
      try {
        this.schedule();
      } catch (error) {
        if (this.blocked === blocked) this.blocked = null;
        reject(error);
      }
    });
  }

  public flush(): void {
    if (this.currentState === 'closed') return;
    if (this.currentState === 'aborted') throw this.terminalReason;
    this.cancelFrame();
    this.commitAllSubmitted();
    this.resetPacingIfIdle();
  }

  public close(): Promise<void> {
    if (this.currentState === 'closed') return Promise.resolve();
    if (this.currentState === 'aborted') return Promise.reject(this.terminalReason);
    if (this.closePromise) return this.closePromise;

    let resolveClose!: () => void;
    let rejectClose!: (reason?: unknown) => void;
    const closePromise = new Promise<void>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    this.closePromise = closePromise;
    this.resolveClose = resolveClose;
    this.rejectClose = rejectClose;

    this.cancelFrame();
    try {
      this.commitAllSubmitted();
    } catch (error) {
      this.rejectPendingClose(error);
      return closePromise;
    }
    if (this.currentState !== 'open') {
      this.rejectPendingClose(this.terminalReason);
      return closePromise;
    }

    this.currentState = 'closed';
    this.cleanup();
    this.resolveClose?.();
    this.resolveClose = null;
    this.rejectClose = null;
    return closePromise;
  }

  public abort(reason?: unknown): void {
    if (this.currentState !== 'open') return;
    this.fail(reason === undefined ? abortError() : reason);
  }

  public destroy(): void {
    this.abort();
  }

  private readonly onFrame = (timestamp: number): void => {
    this.rafId = null;
    if (this.currentState !== 'open') return;

    let keepScheduling = true;
    try {
      if (this.graphemesPerSecond === null) this.commitAccepted();
      else keepScheduling = this.commitPaced(timestamp);
    } catch {
      return;
    }

    if (this.currentState !== 'open') return;
    this.admitBlockedIfPossible();
    this.resetPacingIfIdle();
    if (!keepScheduling) return;
    try {
      this.schedule();
    } catch {
      // A synchronous no-rAF fallback already retained the sink failure.
    }
  };

  private reasonForWrite(): unknown {
    if (this.currentState === 'aborted') return this.terminalReason;
    if (this.currentState === 'closed') return new Error('StreamController is closed');
    return new Error('StreamController is closing');
  }

  private canAdmit(chunk: string): boolean {
    return (
      this.acceptedChars + chunk.length <= this.maxBufferedChars ||
      (this.acceptedChars === 0 && chunk.length > this.maxBufferedChars)
    );
  }

  private admit(chunk: string): void {
    this.chunks.push(chunk);
    this.acceptedChars += chunk.length;
  }

  private admitBlockedIfPossible(): void {
    const blocked = this.blocked;
    if (!blocked || !this.canAdmit(blocked.chunk)) return;
    this.blocked = null;
    this.admit(blocked.chunk);
    blocked.resolve();
  }

  private schedule(): void {
    if (this.currentState !== 'open' || this.acceptedChars === 0 || this.rafId !== null) return;
    if (typeof requestAnimationFrame !== 'function') {
      this.flush();
      return;
    }
    this.rafId = requestAnimationFrame(this.onFrame);
  }

  private cancelFrame(): void {
    if (this.rafId === null) return;
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  private commitAccepted(): void {
    if (this.acceptedChars === 0) return;
    const text = this.takeAcceptedText();
    try {
      this.host.append(text);
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  /** Return true while another frame can make progress without more producer input. */
  private commitPaced(timestamp: number): boolean {
    if (this.lastFrameAt === null) {
      this.lastFrameAt = timestamp;
      return true;
    }

    const delta = Math.min(MAX_FRAME_DELTA_MS, Math.max(0, timestamp - this.lastFrameAt));
    this.lastFrameAt = timestamp;
    this.graphemeCredit += (delta * this.graphemesPerSecond!) / 1000;
    const available = Math.floor(this.graphemeCredit);
    if (available < 1) return true;

    const selected = this.selectGraphemePrefix(available);
    if (selected.count === 0) {
      this.lastFrameAt = null;
      this.graphemeCredit = 0;
      return false;
    }

    const completedBlocked = this.consumeSubmittedChars(selected.codeUnits);
    try {
      this.host.append(selected.text);
      completedBlocked?.resolve();
    } catch (error) {
      completedBlocked?.reject(error);
      this.fail(error);
      throw error;
    }
    this.graphemeCredit -= selected.count;
    return true;
  }

  private selectGraphemePrefix(maxCount: number): GraphemePrefix {
    const submittedChars = this.acceptedChars + (this.blocked?.chunk.length ?? 0);
    let scanLength = Math.min(submittedChars, Math.max(MIN_SCAN_CODE_UNITS, maxCount * 2));

    while (scanLength > 0) {
      let sample = this.peekSubmittedChars(scanLength);
      if (scanLength < submittedChars && /[\uD800-\uDBFF]$/.test(sample)) {
        scanLength++;
        sample = this.peekSubmittedChars(scanLength);
      }

      const segments = [...this.segmenter!.segment(sample)];
      const hasUnscannedText = scanLength < submittedChars;
      if (hasUnscannedText && segments.length <= maxCount) {
        scanLength = Math.min(submittedChars, scanLength * 2);
        continue;
      }

      const count = hasUnscannedText
        ? maxCount
        : Math.min(maxCount, Math.max(0, segments.length - 1));
      if (count > 0) {
        const last = segments[count - 1];
        const codeUnits = last.index + last.segment.length;
        return { text: sample.slice(0, codeUnits), count, codeUnits };
      }

      if (this.blocked || this.acceptedChars > this.maxBufferedChars) {
        return this.forceCodePointPrefix(sample);
      }
      return { text: '', count: 0, codeUnits: 0 };
    }

    return { text: '', count: 0, codeUnits: 0 };
  }

  private forceCodePointPrefix(sample: string): GraphemePrefix {
    const first = sample.charCodeAt(0);
    const second = sample.charCodeAt(1);
    const codeUnits =
      first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff ? 2 : 1;
    return { text: sample.slice(0, codeUnits), count: 1, codeUnits };
  }

  private peekSubmittedChars(limit: number): string {
    const parts = this.peekAcceptedParts(Math.min(limit, this.acceptedChars));
    const acceptedLength = Math.min(limit, this.acceptedChars);
    const blockedLength = limit - acceptedLength;
    if (blockedLength > 0 && this.blocked) {
      parts.push(this.blocked.chunk.slice(0, blockedLength));
    }
    return parts.length === 1 ? parts[0] : parts.join('');
  }

  private peekAcceptedParts(limit: number): string[] {
    if (limit <= 0) return [];
    const parts: string[] = [];
    let remaining = limit;
    for (let index = this.headIndex; index < this.chunks.length && remaining > 0; index++) {
      const chunk = this.chunks[index];
      const start = index === this.headIndex ? this.headOffset : 0;
      const available = chunk.length - start;
      if (available <= remaining) {
        parts.push(start === 0 ? chunk : chunk.slice(start));
        remaining -= available;
      } else {
        parts.push(chunk.slice(start, start + remaining));
        remaining = 0;
      }
    }
    return parts;
  }

  private consumeSubmittedChars(count: number): BlockedWrite | null {
    const acceptedCount = Math.min(count, this.acceptedChars);
    this.consumeAcceptedChars(acceptedCount);
    const blockedCount = count - acceptedCount;
    if (blockedCount === 0) return null;

    const blocked = this.blocked;
    if (!blocked) throw new Error('StreamController queue accounting diverged');
    if (blockedCount >= blocked.chunk.length) {
      this.blocked = null;
      return blocked;
    }
    blocked.chunk = blocked.chunk.slice(blockedCount);
    return null;
  }

  private consumeAcceptedChars(count: number): void {
    if (count < 0 || count > this.acceptedChars) {
      throw new Error('StreamController queue accounting diverged');
    }
    this.acceptedChars -= count;
    let remaining = count;
    while (remaining > 0) {
      const chunk = this.chunks[this.headIndex];
      const available = chunk.length - this.headOffset;
      if (remaining < available) {
        this.headOffset += remaining;
        remaining = 0;
      } else {
        remaining -= available;
        this.headIndex++;
        this.headOffset = 0;
      }
    }

    if (this.acceptedChars === 0) {
      this.chunks = [];
      this.headIndex = 0;
      this.headOffset = 0;
    } else if (this.headIndex >= 64 && this.headIndex * 2 >= this.chunks.length) {
      this.chunks.splice(0, this.headIndex);
      this.headIndex = 0;
    }
  }

  private takeAcceptedText(): string {
    const parts = this.takeAcceptedParts();
    return parts.length === 1 ? parts[0] : parts.join('');
  }

  private takeAcceptedParts(): string[] {
    const parts = this.peekAcceptedParts(this.acceptedChars);
    this.chunks = [];
    this.headIndex = 0;
    this.headOffset = 0;
    this.acceptedChars = 0;
    return parts;
  }

  private commitAllSubmitted(): void {
    const blocked = this.blocked;
    this.blocked = null;
    const parts = this.takeAcceptedParts();
    if (blocked) parts.push(blocked.chunk);
    if (parts.length === 0) return;

    try {
      this.host.append(parts.length === 1 ? parts[0] : parts.join(''));
      blocked?.resolve();
    } catch (error) {
      blocked?.reject(error);
      this.fail(error);
      throw error;
    }
  }

  private rejectPendingClose(reason: unknown): void {
    this.rejectClose?.(reason);
    this.resolveClose = null;
    this.rejectClose = null;
  }

  private fail(reason: unknown): void {
    if (this.currentState !== 'open') return;
    this.currentState = 'aborted';
    this.terminalReason = reason;
    this.cancelFrame();
    this.chunks = [];
    this.headIndex = 0;
    this.headOffset = 0;
    this.acceptedChars = 0;
    const blocked = this.blocked;
    this.blocked = null;
    blocked?.reject(reason);
    this.rejectPendingClose(reason);
    this.cleanup();
  }

  private cleanup(): void {
    this.signal?.removeEventListener('abort', this.onSignalAbort);
    if (this.released) return;
    this.released = true;
    this.host.release(this);
  }

  private resetPacingIfIdle(): void {
    if (this.acceptedChars !== 0 || this.blocked) return;
    this.lastFrameAt = null;
    this.graphemeCredit = 0;
  }
}

/** @internal Bind one controller to a Markdown-owned append sink. */
export function createStreamController(
  host: MarkdownStreamHost,
  options: StreamControllerOptions = {},
): BoundStreamController {
  return new StreamControllerImpl(host, options);
}
