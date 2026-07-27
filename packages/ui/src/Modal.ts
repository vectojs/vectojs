import { UIComponent } from './UIComponent';
import { Card } from './Card';
import { Text } from './Text';
import { Button } from './Button';
import { type A11yAttributes, type Entity, type IRenderer, VectoJSEvent } from '@vectojs/core';

export class Modal extends UIComponent {
  private card: Card;
  private backdropColor: string;
  /** Element focused before the modal opened, restored on close. */
  private _restoreFocusEl: HTMLElement | null = null;
  /** Document-level keydown that keeps Tab inside the dialog while open. */
  private _trapHandler: ((event: KeyboardEvent) => void) | null = null;
  /** Dialog title, kept so it can be projected as the accessible name. */
  private readonly _title: string;

  constructor(title: string, props: any = {}) {
    super();
    this._title = title;
    // The backdrop is the full-viewport focus-catching dialog surface.
    this.a11yFullViewport = true;
    this.width = props.width ?? (typeof window !== 'undefined' ? window.innerWidth : 800);
    this.height = props.height ?? (typeof window !== 'undefined' ? window.innerHeight : 600);
    this.interactive = true;
    this.backdropColor = props.backdropColor ?? 'rgba(0, 0, 0, 0.5)';

    // Central Card modal
    const modalW = props.modalWidth ?? 400;
    const modalH = props.modalHeight ?? 250;
    this.card = new Card({
      width: modalW,
      height: modalH,
      bg: props.cardBg ?? 'rgba(15, 23, 42, 0.95)',
      border: props.cardBorder ?? 'rgba(255, 255, 255, 0.15)',
      radius: 16,
    });

    this.card.x = (this.width - modalW) / 2;
    this.card.y = (this.height - modalH) / 2;

    const titleText = new Text(title, {
      font: '600 20px sans-serif',
      color: '#fff',
    });
    this.card.add(titleText.setPosition(24, 24));

    const closeBtn = new Button('Close', {
      bg: 'rgba(255, 255, 255, 0.1)',
      color: '#fff',
      radius: 8,
    });
    closeBtn.width = 80;
    closeBtn.height = 36;
    closeBtn.on('click', (e: VectoJSEvent) => {
      e.stopPropagation();
      void this.close();
    });
    this.card.add(closeBtn.setPosition(modalW - 104, modalH - 60));

    this.add(this.card);

    // The card scales in on mount (onMounted) and out on close() through the
    // shared animation system's imperative springTo. Seed it collapsed so the
    // mount animation grows it from nothing. The Scene ticks the card each frame
    // (it recurses into descendants), so no per-frame update() override is needed.
    this.card.scaleX = 0;
    this.card.scaleY = 0;

    // Block underlying events
    this.on('click', (e: VectoJSEvent) => e.stopPropagation());
    this.on('pointerdown', (e: VectoJSEvent) => e.stopPropagation());
    // Esc closes the dialog (WAI-ARIA dialog pattern). The keydown reaches the
    // modal's shadow element once it holds focus (set in onMounted).
    this.on('keydown', (e: VectoJSEvent<KeyboardEvent>) => {
      if (e.nativeEvent?.key === 'Escape') {
        e.stopPropagation();
        void this.close();
      }
    });
  }

  /** Expose the modal shell as a real dialog so screen readers announce it and
   *  trap their reading context. `a11yFullViewport` makes the backdrop the
   *  focus-catching surface. */
  public override getA11yAttributes(): A11yAttributes {
    return {
      role: 'dialog',
      ariaModal: 'true',
      tabIndex: -1,
      // The title is drawn on canvas, so it never reached the semantic layer:
      // a screen reader announced a bare "dialog" with no indication of what it
      // was for (WCAG 4.1.2, and axe's aria-dialog-name rule). Project it.
      label: this._title,
    };
  }

  /**
   * Focusable projected elements belonging to this modal's subtree, in reading
   * order.
   *
   * Walks the ENTITY tree rather than querying DOM descendants: the a11y
   * projection is flat — every element is appended directly to `a11yRoot` as a
   * sibling, with reading order maintained by sorting rather than nesting — so
   * `dialogElement.contains(child)` is always false and a DOM-scoped query finds
   * nothing. This cost me a wrong first implementation that trapped focus on the
   * dialog surface and never reached the buttons inside it.
   *
   * `tabindex="-1"` is excluded: the dialog surface carries it and is
   * programmatically focusable but not a tab stop.
   */
  private focusableInside(): HTMLElement[] {
    const scene = this.scene;
    if (!scene) return [];
    const out: HTMLElement[] = [];
    const visit = (node: Entity): void => {
      const el = scene.getA11yElement(node.id);
      if (el && el !== scene.getA11yElement(this.id)) {
        const disabled = el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
        const visible = el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
        if (el.tabIndex >= 0 && !disabled && visible) out.push(el);
      }
      for (const child of node.children) visit(child);
    };
    visit(this);
    return out;
  }

  /** Whether `el` is one of this modal's projected elements (its own surface
   *  included). Needed because DOM containment cannot answer this — see
   *  {@link focusableInside}. */
  private ownsElement(el: Element | null): boolean {
    if (!el) return false;
    const scene = this.scene;
    if (!scene) return false;
    const id = el.getAttribute('data-vecto-id');
    if (!id) return false;
    if (id === this.id) return true;
    let found = false;
    const visit = (node: Entity): void => {
      if (found) return;
      if (node.id === id) {
        found = true;
        return;
      }
      for (const child of node.children) visit(child);
    };
    visit(this);
    return found;
  }

  /**
   * Contain Tab within the dialog (WAI-ARIA dialog pattern).
   *
   * `aria-modal="true"` tells assistive technology that outside content is inert,
   * but it does **not** stop the browser's own Tab order from leaving. Measured in
   * real Chrome and Firefox before this existed: the first Tab after opening
   * landed on a background control, and successive ones walked the entire page
   * behind the dialog — a keyboard user operating things they could not see.
   *
   * A document-level capture-phase `keydown` wraps focus at both ends. Native
   * `<dialog>` + `showModal()` would give this for free, but the projection builds
   * plain elements, so the trap must be explicit.
   */
  private installFocusTrap(): void {
    if (typeof document === 'undefined' || this._trapHandler) return;
    const handler = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return;
      const focusable = this.focusableInside();
      const surface = this.scene?.getA11yElement(this.id) ?? null;

      // Nothing focusable inside: hold focus on the dialog surface rather than
      // letting Tab escape to the background.
      if (focusable.length === 0) {
        event.preventDefault();
        surface?.focus();
        return;
      }

      const active = document.activeElement as HTMLElement | null;
      const index = active ? focusable.indexOf(active) : -1;

      // Always drive the next stop ourselves rather than only wrapping at the
      // ends. The tempting version — preventDefault only when focus is on the
      // first/last element — does not work here: the projection rebuilds pooled
      // hotspots on every a11y sync, so `focusable` holds fresh element
      // identities each press and the currently focused hotspot matches neither
      // end. No branch fires, the default Tab runs, and focus leaks to the
      // background on alternating presses. Measured in real Chrome: press 1
      // stayed inside, press 2 landed on a background button, repeating.
      event.preventDefault();

      if (index < 0) {
        // Focus outside the dialog, or on its own surface (tabIndex -1, so never
        // in `focusable`): enter at the appropriate edge.
        (event.shiftKey ? focusable[focusable.length - 1]! : focusable[0]!).focus();
      } else {
        const next = event.shiftKey
          ? (index - 1 + focusable.length) % focusable.length
          : (index + 1) % focusable.length;
        focusable[next]!.focus();
      }

      // A hotspot torn down between lookup and focus() would leave focus
      // unmoved, and focus() on a detached element fails silently. The dialog
      // surface is stable, so fall back to it rather than let Tab continue.
      if (!this.ownsElement(document.activeElement)) surface?.focus();
    };
    document.addEventListener('keydown', handler, true);
    this._trapHandler = handler;
  }

  private removeFocusTrap(): void {
    if (!this._trapHandler || typeof document === 'undefined') return;
    document.removeEventListener('keydown', this._trapHandler, true);
    this._trapHandler = null;
  }

  protected override onMounted(): void {
    // Remember what had focus so we can restore it on close (WAI-ARIA dialog).
    this._restoreFocusEl =
      typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
    void this.card.springTo({ scaleX: 1, scaleY: 1 }, { stiffness: 180, damping: 14 });
    // Move focus into the dialog so Esc/keyboard work and SR context enters it.
    this.focus();
    this.installFocusTrap();
  }

  /** Tear the trap down if the modal is destroyed without going through close()
   *  — otherwise a document listener outlives the dialog and traps Tab forever.
   *  There is no unmount hook on Entity, so destroy() is the teardown point. */
  public override destroy(): void {
    this.removeFocusTrap();
    super.destroy();
  }

  /** Animate the card out, then remove the modal from its overlay layer and
   *  restore focus to whatever held it before the modal opened. */
  public async close(): Promise<void> {
    await this.card.springTo({ scaleX: 0, scaleY: 0 }, { stiffness: 220, damping: 20 });
    this.removeFocusTrap();
    this.scene?.hideOverlay(this);
    this._restoreFocusEl?.focus?.();
    this._restoreFocusEl = null;
  }

  public render(r: IRenderer): void {
    // Draw blocking dark backdrop overlay
    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, 0);
    r.fill(this.backdropColor);
  }
}
