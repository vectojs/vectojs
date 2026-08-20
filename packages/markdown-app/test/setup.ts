import { vi } from 'vitest';

HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
  measureText: (text: string) => ({ width: text.length * 8 }),
})) as unknown as typeof HTMLCanvasElement.prototype.getContext;
