import { WORKER_SOURCE_STRING } from './LayoutWorkerSource';
import { LayoutWorkerRequest, LayoutWorkerResponse } from './LayoutWorker';

export class LayoutWorkerManager {
  private static instance: LayoutWorkerManager;
  private worker: Worker;
  private registeredFonts = new Set<string>();
  private pendingCallbacks = new Map<string, (response: any) => void>();
  private seqIdCounter = new Map<string, number>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private constructor() {
    const workerBlob = new Blob([WORKER_SOURCE_STRING], { type: 'application/javascript' });
    const workerURL = URL.createObjectURL(workerBlob);
    this.worker = new Worker(workerURL);
    setTimeout(() => URL.revokeObjectURL(workerURL), 2000);

    this.worker.onmessage = (e: MessageEvent) => {
      const response = e.data as LayoutWorkerResponse;
      const callback = this.pendingCallbacks.get(`${response.id}-${response.seqId}`);
      if (callback) {
        callback(response);
        this.pendingCallbacks.delete(`${response.id}-${response.seqId}`);
      }
    };
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
      callback: (res: LayoutWorkerResponse) => void;
    },
  ): void {
    // Clear existing debounce timer for entity (per-entity scope)
    const existingTimer = this.debounceTimers.get(entityId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const runLayout = () => {
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
      };

      if (!this.registeredFonts.has(options.fontId) && options.fontData) {
        request.fontData = options.fontData;
        this.registeredFonts.add(options.fontId);
      }

      this.pendingCallbacks.set(`${entityId}-${nextSeqId}`, options.callback);
      this.worker.postMessage(request);
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
    this.seqIdCounter.delete(entityId);
  }
}
