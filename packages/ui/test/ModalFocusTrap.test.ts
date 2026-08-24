// @vitest-environment jsdom
//
// Modal focus-trap liveness (#691): the trap is a document-level capture
// keydown listener removed only by close()/destroy(). `scene.hideOverlay()`
// unprojects the overlay subtree WITHOUT destroying it, so an owner bypassing
// close() used to strand the trap — every Tab press anywhere in the document
// was preventDefault'd into an invisible dialog, and `_restoreFocusEl` was
// never restored. The handler now self-checks liveness and removes itself.
//
// Lives in its own file: tests in this file each get a fresh jsdom document,
// whereas a leaked-but-still-open modal from another test in the same file
// would keep trapping real Tab dispatches (the very defect class under test).
import { describe, it, expect } from 'vitest';
import { Modal } from '../src/Modal';
import { Scene } from '@vectojs/core';

describe('Modal focus trap liveness (#691)', () => {
  it('releases the trap when dismissed via scene.hideOverlay', () => {
    const canvas = document.createElement('canvas');
    const scene = new Scene(canvas);
    const modal = new Modal('Trap', { width: 300, height: 200 });
    scene.showOverlay(modal); // onMounted installs the document-level trap
    expect(typeof (modal as unknown as { _trapHandler: unknown })._trapHandler).toBe('function');

    // An owner that bypasses close(): overlay unprojected, entity NOT destroyed.
    scene.hideOverlay(modal);
    expect(scene.overlayRoot.children.length).toBe(0);

    // The next Tab must not be swallowed into the invisible dialog — the trap
    // self-checks liveness, removes itself, and lets the event proceed.
    const tab = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    document.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    expect((modal as unknown as { _trapHandler: unknown })._trapHandler).toBeNull();

    // And it stays gone (no resurrection on later keypresses).
    const tab2 = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    document.dispatchEvent(tab2);
    expect(tab2.defaultPrevented).toBe(false);
  });

  it('keeps trapping Tab while the modal is alive', () => {
    const canvas = document.createElement('canvas');
    const scene = new Scene(canvas);
    const modal = new Modal('Live', { width: 300, height: 200 });
    scene.showOverlay(modal);

    const tab = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    document.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);

    scene.hideOverlay(modal); // leave the document clean for later tests
  });
});
