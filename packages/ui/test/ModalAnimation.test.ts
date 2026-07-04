import { describe, it, expect } from 'vitest';
import { Modal } from '../src/Modal';

describe('Modal animation', () => {
  it('no longer holds its own SpringPhysics instance', () => {
    const m = new Modal('Title');
    expect((m as unknown as { spring?: unknown }).spring).toBeUndefined();
  });

  it('seeds the card collapsed and exposes an async close()', () => {
    const m = new Modal('Title');
    const card = (m as unknown as { card: { scaleX: number; scaleY: number } }).card;
    expect(card.scaleX).toBe(0); // collapsed; animates in on mount
    expect(card.scaleY).toBe(0);
    expect(m.close()).toBeInstanceOf(Promise);
  });
});
