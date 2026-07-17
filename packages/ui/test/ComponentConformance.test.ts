// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { Entity, Scene } from '@vectojs/core';
import {
  Overlay,
  Panel,
  PanelGroup,
  PanelResizeHandle,
  ProgressBar,
  RadioGroup,
  ScrollView,
  Stack,
  Tabs,
  TreeView,
  VirtualList,
  Text,
  Button,
  Link,
  Card,
  Flow,
  Input,
  TextArea,
  RichText,
  Checkbox,
  Toggle,
  Table,
  Slider,
  Modal,
  Tooltip,
  Popover,
  ContextMenu,
  Dropdown,
} from '../src/index';

/**
 * Component conformance suite — one shared matrix every `@vectojs/ui`
 * component must pass. Generalizes the id-uniqueness check pinned by
 * `EntityIds.test.ts` (kept as its own file: it also covers the two-scene
 * live a11y-DOM-collision repro, which doesn't fit this matrix shape) into
 * five checks that convert five recurring bug classes into a checklist a
 * new component can't skip:
 *
 * (a) two instances in one scene → unique ids, independent event routing
 * (b) API calls before first mount → defined behavior, never a silent no-op
 * (c) any time-driven visual state → hasPendingAnimations() reports it
 * (d) parent resize → child tracks, or is exempted with a documented reason
 * (e) destroy()/remove() → no leaked a11y nodes or timers
 *
 * See `vectojs-docs/superpowers/specs/2026-07-17-engineering-backlog-synthesis.md`
 * (Tier 1 #1) for the origin of this suite.
 */

/** Minimal leaf entity for use as filler content inside containers. */
class Leaf extends Entity {
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

function makeScene(): {
  scene: Scene;
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  tick: (n?: number) => void;
} {
  const host = document.createElement('div');
  const canvas = document.createElement('canvas');
  host.appendChild(canvas);
  document.body.appendChild(host);
  const scene = new Scene(canvas);
  (scene as unknown as { isRunning: boolean }).isRunning = true;
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++) {
      (scene as unknown as { loop: (t: number) => void }).loop(i * 16);
    }
  };
  return { scene, root: host, canvas, tick };
}

/**
 * Every conformance-checked component, with a factory and per-check
 * capability flags. Components genuinely differ in what applies to them
 * (e.g. `Text` has no click surface to route events to; `Table` isn't
 * resizable-by-parent-tracking by design) — the flags make that an
 * explicit, reviewable decision instead of a silent gap in coverage.
 */
interface ComponentSpec {
  name: string;
  make: () => Entity;
  /** False when the component has no click/pointer surface of its own to
   * route events to (e.g. static Text, static ProgressBar). */
  interactive?: boolean;
  /** True when the component is documented/expected to NOT track parent
   * resize (check (d) becomes "asserts it does NOT resize" instead of
   * "asserts it does"). Absence of either flag means "not yet decided" —
   * every entry below sets one explicitly, on purpose. */
  resizeExempt?: boolean;
  /** Optional: mutate the instance to trigger its documented time-driven
   * animation (e.g. call showAtPoint on an Overlay) for check (c). Absent
   * means the component has no animation to check. Takes the same instance
   * `make()` returned (by reference, not by reflecting on private fields —
   * component classes are free to keep their constructor args private). */
  triggerAnimation?: (instance: Entity, scene: Scene) => void;
}

const SPECS: ComponentSpec[] = [
  { name: 'Stack', make: () => new Stack(), interactive: false, resizeExempt: true },
  {
    name: 'Flow',
    make: () => new Flow(),
    interactive: false,
    resizeExempt: true,
  },
  {
    name: 'ScrollView',
    make: () => new ScrollView({ width: 100, height: 100 }),
    interactive: true,
    // ScrollView owns its box; nothing in the public API resizes it in
    // response to a parent — it's sized explicitly by its own options.
    resizeExempt: true,
  },
  {
    name: 'Overlay',
    make: () => new Overlay({ width: 100, height: 100 }),
    interactive: false,
    resizeExempt: true,
    triggerAnimation: (instance, scene) => {
      (instance as Overlay).showAtPoint(10, 10, scene);
    },
  },
  {
    name: 'VirtualList',
    make: () =>
      new VirtualList({
        items: [1, 2],
        renderItem: () => new Leaf(),
        estimatedRowHeight: 20,
        width: 100,
        height: 100,
      }),
    interactive: true,
    resizeExempt: true,
  },
  {
    name: 'RadioGroup',
    make: () => new RadioGroup({ options: [{ value: 'a', label: 'A' }] }),
    interactive: true,
    resizeExempt: true,
  },
  {
    name: 'ProgressBar',
    make: () => new ProgressBar({ value: 0.5 }),
    interactive: false,
    resizeExempt: true,
  },
  {
    name: 'Tabs',
    make: () => new Tabs({ width: 300, height: 100, tabs: [] }),
    interactive: true,
    // Tabs positions content but does not size it — the exact gap tracked
    // as "container sizing contract" (Tier 1 #2 in the backlog). Documented
    // exemption, not a silent gap: this IS the open finding.
    resizeExempt: true,
  },
  {
    name: 'TreeView',
    make: () => new TreeView({ nodes: [{ id: 'n', label: 'n' }], width: 100, height: 100 }),
    interactive: true,
    resizeExempt: true,
  },
  {
    name: 'Panel',
    make: () => new Panel(),
    interactive: false,
    // Still exempt for check (d)'s actual question ("does an ANCESTOR's
    // resize propagate into this bare component"), which is unaffected by
    // Panel.setContent's new fitContent contract — that contract governs
    // the OPPOSITE relationship (Panel -> its own hosted content), covered
    // by dedicated tests in ResizablePanel.test.ts instead, since check (d)
    // never constructs a Panel via setContent() (spec.make() here returns a
    // bare, content-less Panel).
    resizeExempt: true,
  },
  {
    name: 'PanelGroup',
    make: () => new PanelGroup({ width: 100, height: 100, direction: 'horizontal' }),
    interactive: false,
    resizeExempt: true,
  },
  {
    name: 'PanelResizeHandle',
    make: () => new PanelResizeHandle('horizontal', 4, '#000', '#fff', () => {}),
    interactive: true,
    resizeExempt: true,
  },
  {
    name: 'Text',
    make: () => new Text('hello'),
    interactive: false,
    resizeExempt: true,
  },
  {
    name: 'Button',
    make: () => new Button('Click me'),
    interactive: true,
    resizeExempt: true,
  },
  {
    name: 'Link',
    make: () => new Link('Go', { href: 'https://example.com' }),
    interactive: true,
    resizeExempt: true,
  },
  {
    // No `label`/`onClick` → not interactive — a purely decorative Card
    // still has no click surface of its own, by design (see the interactive
    // variant below for the Pressable-style `onClick` contract, Tier 1 #2
    // companion fix, container-sizing-contract-design.md).
    name: 'Card',
    make: () => new Card({ width: 100, height: 60 }),
    interactive: false,
    // Still exempt for check (d)'s ancestor-resize question, same rationale
    // as Panel above — Card.setContent's fitContent contract governs the
    // Card-to-its-own-hosted-content relationship instead, covered by
    // dedicated tests in Card.test.ts.
    resizeExempt: true,
  },
  {
    name: 'Card (interactive, onClick)',
    make: () => new Card({ width: 100, height: 60, label: 'Feature card', onClick: () => {} }),
    interactive: true,
    resizeExempt: true,
  },
  {
    name: 'Input',
    make: () => new Input({ width: 200 }),
    interactive: true,
    resizeExempt: true,
    // No `triggerAnimation`: Input's caret blink is deliberately NOT reported
    // via hasPendingAnimations() (see UIComponent.startCaretBlinkWake's own
    // doc comment) — it wakes the scene with a setTimeout per 500ms phase
    // boundary instead, specifically so a focused-but-idle field doesn't pin
    // the scene at full frame rate the way a permanent pending-animation flag
    // would. Covered instead by the dedicated timer-leak test in section (e)
    // below, which is the actual risk this mechanism carries.
  },
  {
    name: 'TextArea',
    make: () => new TextArea({ width: 200 }),
    interactive: true,
    resizeExempt: true,
  },
  {
    name: 'RichText',
    make: () => new RichText([{ text: 'hello world' }]),
    interactive: false,
    resizeExempt: true,
  },
  {
    name: 'Checkbox',
    make: () => new Checkbox({}),
    interactive: true,
    resizeExempt: true,
  },
  {
    name: 'Toggle',
    make: () => new Toggle({}),
    interactive: true,
    resizeExempt: true,
  },
  {
    name: 'Table',
    make: () =>
      new Table({
        headers: ['A', 'B'],
        rows: [['1', '2']],
      }),
    interactive: false,
    resizeExempt: true,
  },
  {
    name: 'Slider',
    make: () => new Slider({}),
    interactive: true,
    resizeExempt: true,
  },
  {
    name: 'Modal',
    make: () => new Modal('Title'),
    interactive: true,
    resizeExempt: true,
    triggerAnimation: (instance, scene) => {
      scene.showOverlay(instance);
    },
  },
  (() => {
    // Tooltip needs its own `target` reachable from `triggerAnimation`
    // without reflecting into the instance's private `_target` field — keep
    // it in this closure instead of guessing a public field name (which
    // silently no-oped the trigger in an earlier draft of this spec: guessing
    // `.target` read `undefined`, `if (target)` was false, showAt() was never
    // called, and the test would have falsely reported the animation as
    // absent rather than catching an engine bug — a reminder this suite has
    // to be as careful about false negatives as it is about the bugs it's
    // built to catch).
    let target: Card;
    return {
      name: 'Tooltip',
      make: () => {
        target = new Card({ width: 10, height: 10, label: 'target' });
        return new Tooltip({ target, content: 'hi' });
      },
      interactive: false,
      resizeExempt: true,
      triggerAnimation: (instance) => {
        (instance as Tooltip).showAt(target);
      },
    };
  })(),
  {
    name: 'Popover',
    make: () => {
      const target = new Card({ width: 10, height: 10, label: 'target' });
      return new Popover({ target, width: 100, height: 60 });
    },
    interactive: false,
    resizeExempt: true,
  },
  {
    name: 'ContextMenu',
    make: () => new ContextMenu({ items: [{ label: 'Item' }] }),
    interactive: false,
    resizeExempt: true,
    triggerAnimation: (instance, scene) => {
      (instance as ContextMenu).showAtPoint(10, 10, scene);
    },
  },
  {
    name: 'Dropdown',
    make: () => new Dropdown(['a', 'b']),
    interactive: true,
    resizeExempt: true,
  },
];

describe('component conformance: (a) unique ids across instances', () => {
  for (const spec of SPECS) {
    it(`${spec.name}: two instances differ`, () => {
      expect(spec.make().id).not.toBe(spec.make().id);
    });
  }
});

describe('component conformance: (a) two instances in one scene route pointer events independently', () => {
  const interactiveSpecs = SPECS.filter((s) => s.interactive);
  for (const spec of interactiveSpecs) {
    it(`${spec.name}: pointerdown on instance A never fires instance B's listener`, () => {
      const { scene, tick } = makeScene();
      const a = spec.make();
      const b = spec.make();
      a.setPosition(0, 0);
      b.setPosition(500, 0);
      scene.add(a);
      scene.add(b);
      tick();

      let aFired = 0;
      let bFired = 0;
      a.on('pointerdown', () => aFired++);
      b.on('pointerdown', () => bFired++);

      const elA = scene.getA11yElement(a.id);
      expect(elA, `${spec.name} instance A projected no a11y element`).toBeTruthy();
      elA!.dispatchEvent(
        new (globalThis as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent(
          'pointerdown',
          { bubbles: true, button: 0 },
        ),
      );

      expect(aFired).toBe(1);
      expect(bFired).toBe(0);
    });
  }
});

describe('component conformance: (b) API calls before first mount never silently no-op', () => {
  // Only components with a documented "show at an unmounted instance" style
  // API are checked here — this is exactly the showAtPoint bug class
  // (Overlay/ContextMenu/Tooltip/Popover), not a claim every component has
  // such an API. Absence from this list means "not applicable", which is
  // itself the point: a future Overlay-like component MUST add itself here
  // or reviewers should ask why not.
  it('Overlay.showAtPoint on a never-mounted instance resolves via source arg, not a scene.add() pre-mount', () => {
    const { scene } = makeScene();
    const overlay = new Overlay({ width: 50, height: 50 });
    expect(overlay.parent).toBeNull();
    overlay.showAtPoint(10, 10, scene);
    expect(overlay.parent).toBe(scene.overlayRoot);
    expect(overlay.visible).toBe(true);
  });

  it('ContextMenu.showAtPoint on a never-mounted instance resolves via source arg', () => {
    const { scene } = makeScene();
    const menu = new ContextMenu({ items: [{ label: 'Item' }] });
    expect(menu.parent).toBeNull();
    menu.showAtPoint(10, 10, scene);
    expect(menu.parent).toBe(scene.overlayRoot);
    expect(menu.visible).toBe(true);
  });

  it('Tooltip.showAt on a never-mounted instance resolves scene from its target', () => {
    const { scene } = makeScene();
    const target = new Card({ width: 10, height: 10, label: 'target' });
    scene.add(target);
    const tooltip = new Tooltip({ target, content: 'hi' });
    expect(tooltip.parent).toBeNull();
    tooltip.showAt(target);
    expect(tooltip.parent).toBe(scene.overlayRoot);
    expect(tooltip.visible).toBe(true);
  });
});

describe('component conformance: (c) time-driven visual state reports via hasPendingAnimations()', () => {
  const animatedSpecs = SPECS.filter((s) => s.triggerAnimation);
  for (const spec of animatedSpecs) {
    it(`${spec.name}: reports hasPendingAnimations() (on itself or a descendant) after its documented trigger`, () => {
      const { scene } = makeScene();
      const instance = spec.make();
      scene.add(instance);
      spec.triggerAnimation!(instance, scene);
      // Some components (e.g. Modal) delegate their enter/exit motion to an
      // internal child (Modal animates its card, not the Modal entity
      // itself), which is a legitimate design — the SCENE still needs to
      // know something is mid-animation to avoid the idle-throttle freezing
      // it, and that signal is per-entity, so check the whole subtree rather
      // than assuming the top-level instance always carries it itself.
      const anyPending = (e: Entity): boolean =>
        e.hasPendingAnimations() || e.children.some(anyPending);
      expect(
        anyPending(instance),
        `${spec.name} triggered a visual transition but neither it nor any descendant reports hasPendingAnimations() — the idle-throttle would freeze it mid-animation`,
      ).toBe(true);
    });
  }
});

describe('component conformance: (d) parent resize — child tracks, or is a documented exemption', () => {
  for (const spec of SPECS) {
    it(`${spec.name}: ${spec.resizeExempt ? 'documented as NOT tracking parent resize' : 'tracks parent resize'}`, () => {
      const parent = new Stack();
      const child = spec.make();
      const widthBefore = child.width;
      parent.add(child);
      parent.width = (parent.width || 0) + 500;
      // Stack (the parent used here) never resizes children on its own
      // width change — it only positions them. This test's job is NOT to
      // assert Stack's own behavior; it documents, per component, whether
      // that component's own public API offers ANY resize-tracking hook at
      // all. If resizeExempt is false for a future component, the fix
      // belongs in that component (an onResize/fitContent hook — see the
      // container sizing contract backlog item), not in this test.
      if (spec.resizeExempt) {
        expect(child.width).toBe(widthBefore);
      } else {
        expect(child.width).not.toBe(widthBefore);
      }
    });
  }
});

describe('component conformance: (e) destroy()/remove() leaves no a11y nodes or timers', () => {
  for (const spec of SPECS) {
    it(`${spec.name}: scene.remove() detaches all a11y shadow elements recursively`, () => {
      const { scene, tick } = makeScene();
      const instance = spec.make();
      scene.add(instance);
      tick();

      const idsBeforeRemove: string[] = [];
      const walk = (e: Entity) => {
        idsBeforeRemove.push(e.id);
        e.children.forEach(walk);
      };
      walk(instance);

      scene.remove(instance);

      for (const id of idsBeforeRemove) {
        expect(
          scene.getA11yElement(id),
          `${spec.name}: entity id ${id} still has an a11y shadow element after scene.remove()`,
        ).toBeUndefined();
      }
    });
  }

  it('Input: destroy() clears the caret-blink timer (no leaked setTimeout)', () => {
    vi.useFakeTimers();
    try {
      const { scene } = makeScene();
      const input = new Input({ width: 200 });
      scene.add(input);
      (input as unknown as { focused: boolean }).focused = true;
      (input as unknown as { startCaretBlinkWake: () => void }).startCaretBlinkWake();

      const pendingBefore = vi.getTimerCount();
      expect(pendingBefore).toBeGreaterThan(0);

      input.destroy();

      const pendingAfter = vi.getTimerCount();
      expect(
        pendingAfter,
        'Input.destroy() should clear its caret-blink setTimeout, not leave it pending',
      ).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
