import { WORKER_SOURCE_STRING } from './LayoutWorkerSource';
import { LayoutWorkerRequest, LayoutWorkerResponse } from './LayoutWorker';

export class LayoutWorkerManager {
  private static instance: LayoutWorkerManager | undefined;
  private worker: Worker | null = null;
  private registeredFonts = new Set<string>();
  private pendingCallbacks = new Map<string, (response: any) => void>();
  private seqIdCounter = new Map<string, number>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private constructor() {
    this.worker = this.createWorker();
  }

  private createWorker(): Worker {
    const workerBlob = new Blob([WORKER_SOURCE_STRING], {
      type: 'application/javascript',
    });
    const workerURL = URL.createObjectURL(workerBlob);
    let worker: Worker;
    try {
      worker = new Worker(workerURL);
    } finally {
      URL.revokeObjectURL(workerURL);
    }

    worker.onmessage = (e: MessageEvent) => {
      if (this.worker !== worker) return;
      const response = e.data as LayoutWorkerResponse;
      const key = `${response.id}-${response.seqId}`;
      const callback = this.pendingCallbacks.get(key);
      if (callback) {
        this.pendingCallbacks.delete(key);
        callback(response);
      }
    };

    worker.onerror = () => this.handleWorkerFailure(worker);
    worker.onmessageerror = () => this.handleWorkerFailure(worker);
    return worker;
  }

  private ensureWorker(): Worker {
    if (!this.worker) this.worker = this.createWorker();
    return this.worker;
  }

  private handleWorkerFailure(worker: Worker): void {
    if (this.worker !== worker) return;
    worker.terminate();
    this.worker = null;
    this.pendingCallbacks.clear();
    this.registeredFonts.clear();
  }

  public destroy(): void {
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    this.pendingCallbacks.clear();
    this.seqIdCounter.clear();
    this.registeredFonts.clear();
    this.worker?.terminate();
    this.worker = null;
    if (LayoutWorkerManager.instance === this) LayoutWorkerManager.instance = undefined;
  }

  public static getInstance(): LayoutWorkerManager {
    if (!LayoutWorkerManager.instance) {
      LayoutWorkerManager.instance = new LayoutWorkerManager();
    }
    return LayoutWorkerManager.instance;
  }

  public queueLayout(
    entityId: string,
    text: string,
    options: {
      fontId: string;
      fontSize: number;
      maxWidth: number;
      maxHeight: number;
      fontData?: any;
      lineHeight?: number;
      letterSpacing?: number;
      textAlign?: 'left' | 'justify';
      callback: (res: LayoutWorkerResponse) => void;
    },
  ): void {
    // Clear existing debounce timer for entity (per-entity scope)
    const existingTimer = this.debounceTimers.get(entityId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const runLayout = () => {
      this.debounceTimers.delete(entityId);
      const nextSeqId = (this.seqIdCounter.get(entityId) ?? 0) + 1;
      this.seqIdCounter.set(entityId, nextSeqId);

      const request: LayoutWorkerRequest = {
        id: entityId,
        seqId: nextSeqId,
        text,
        fontId: options.fontId,
        maxWidth: options.maxWidth,
        maxHeight: options.maxHeight,
        fontSize: options.fontSize,
        lineHeight: options.lineHeight,
        letterSpacing: options.letterSpacing,
        textAlign: options.textAlign,
      };

      if (!this.registeredFonts.has(options.fontId) && options.fontData) {
        request.fontData = options.fontData;
        this.registeredFonts.add(options.fontId);
      }

      this.pendingCallbacks.set(`${entityId}-${nextSeqId}`, options.callback);
      try {
        this.ensureWorker().postMessage(request);
      } catch {
        const worker = this.worker;
        if (worker) this.handleWorkerFailure(worker);
      }
    };

    // Leading-edge debounce: execute immediately on first request, buffer subsequent ones by 50ms
    if (!this.seqIdCounter.has(entityId)) {
      runLayout();
    } else {
      const timer = setTimeout(runLayout, 50);
      this.debounceTimers.set(entityId, timer);
    }
  }

  public cancelLayout(entityId: string): void {
    const existingTimer = this.debounceTimers.get(entityId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.debounceTimers.delete(entityId);
    }
    // Remove any in-flight callback entries for this entity so we don't
    // pin a closure + `this` reference if the entity is destroyed while
    // the worker is still processing (the worker's response will be
    // discarded below).
    for (const key of this.pendingCallbacks.keys()) {
      if (key.startsWith(`${entityId}-`)) this.pendingCallbacks.delete(key);
    }
    this.seqIdCounter.delete(entityId);
  }
}
