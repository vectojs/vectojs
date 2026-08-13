// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Entity, Scene, type A11yAttributes } from '@vectojs/core';
import { a11yReadingOrder, auditA11y, inspectA11y, type A11yAuditKind } from '../src/a11yInspect';

/**
 * Accessibility inspector and audits.
 *
 * The audits target failure classes already observed in this codebase (#212, #221,
 * #229, #235, #237), not a generic checklist, so each test pairs a defect that
 * should fire with a correct case that must stay quiet. False positives matter as
 * much as misses here: an audit that cries wolf gets switched off and then catches
 * nothing.
 */
class Node extends Entity {
  private attrs: A11yAttributes;
  private label?: string;

  constructor(attrs: A11yAttributes = {}, opts: { text?: string } = {}) {
    super();
    this.attrs = attrs;
    this.label = opts.text;
    this.width = 40;
    this.height = 20;
  }

  public override getA11yAttributes(): A11yAttributes {
    return this.attrs;
  }

  public get text(): string | undefined {
    return this.label;
  }

  public override render(): void {}
}

function makeScene(): Scene {
  const canvas = document.createElement('canvas');
  canvas.width = 400;
  canvas.height = 300;
  (canvas as unknown as { getContext: () => unknown }).getContext = () => ({
    measureText: (t: string) => ({ width: String(t).length * 8 }),
    canvas,
    save() {},
    restore() {},
    translate() {},
    scale() {},
    clearRect() {},
    fillRect() {},
    fillText() {},
    beginPath() {},
    setTransform() {},
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
  });
  document.body.appendChild(canvas);
  const scene = new Scene(canvas, { disableWindowResize: true });
  scene.resize(400, 300);
  return scene;
}

const kinds = (findings: Array<{ kind: A11yAuditKind }>): A11yAuditKind[] =>
  findings.map((f) => f.kind);

describe('inspectA11y', () => {
  let scene: Scene;
  beforeEach(() => {
    scene = makeScene();
  });

  it('resolves the accessible name from an explicit label and says so', () => {
    const node = new Node({ tag: 'button', label: 'Save' });
    scene.add(node);
    const info = inspectA11y(scene, node);
    expect(info.accessibleName).toBe('Save');
    // Knowing WHERE the name came from is what makes a missing name fixable at
    // the right layer.
    expect(info.nameSource).toBe('label');
  });

  it('falls back to text content and reports that source', () => {
    const node = new Node({ tag: 'button' }, { text: 'Cancel' });
    scene.add(node);
    const info = inspectA11y(scene, node);
    expect(info.accessibleName).toBe('Cancel');
    expect(info.nameSource).toBe('text');
  });

  it('reports nameSource none when there is no name at all', () => {
    const node = new Node({ tag: 'button' });
    scene.add(node);
    expect(inspectA11y(scene, node).nameSource).toBe('none');
  });

  it('carries tabIndex, disabled and role through', () => {
    const node = new Node({
      tag: 'button',
      role: 'button',
      tabIndex: -1,
      disabled: true,
    });
    scene.add(node);
    const info = inspectA11y(scene, node);
    expect(info.tabIndex).toBe(-1);
    expect(info.disabled).toBe(true);
    expect(info.role).toBe('button');
  });

  it('always reports canvas bounds, and marks unprojected entities', () => {
    const plain = new Node({});
    plain.x = 10;
    plain.y = 20;
    scene.add(plain);
    const info = inspectA11y(scene, plain);
    expect(info.canvasBounds).toEqual({ x: 10, y: 20, width: 40, height: 20 });
    expect(info.projected).toBe(false);
  });

  it('normalizes domBounds to scene units when the canvas is CSS-scaled', () => {
    // Canvas CSS width is HALF the logical width: the a11y root then carries
    // `transform: scale(0.5, 0.5)`, so a client rect of the projected node is
    // half the entity's logical size. domBounds must be converted back to scene
    // units, or a perfectly aligned projection reads as diverging from the
    // canvas (drift threshold >1px).
    const node = new Node({ tag: 'button', label: 'Save' }); // 40×20 at (0,0)
    scene.add(node);
    const el = document.createElement('div');
    vi.spyOn(scene, 'getA11yElement').mockReturnValue(el as HTMLElement);
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 20,
      bottom: 10,
      width: 20,
      height: 10,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    vi.spyOn(scene.canvas, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 200,
      bottom: 150,
      width: 200,
      height: 150,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    const info = inspectA11y(scene, node);
    expect(info.domBounds).toEqual({ x: 0, y: 0, width: 40, height: 20 });
  });
});

describe('auditA11y: no-accessible-name', () => {
  it('fires for a focusable node with no name — the defect #212 found', () => {
    const scene = makeScene();
    const button = new Node({ tag: 'button', role: 'button' });
    button.interactive = true;
    scene.add(button);
    const found = auditA11y(scene);
    expect(kinds(found)).toContain('no-accessible-name');
    expect(found[0]!.message).toContain('announces only its role');
  });

  it('stays quiet when a name is present', () => {
    const scene = makeScene();
    const button = new Node({ tag: 'button', role: 'button', label: 'Send' });
    button.interactive = true;
    scene.add(button);
    expect(kinds(auditA11y(scene))).not.toContain('no-accessible-name');
  });

  it('stays quiet for a non-focusable decorative node', () => {
    const scene = makeScene();
    scene.add(new Node({ tag: 'div' }));
    expect(kinds(auditA11y(scene))).not.toContain('no-accessible-name');
  });
});

describe('auditA11y: role-tag-conflict', () => {
  it('fires when an explicit role contradicts the tag', () => {
    const scene = makeScene();
    scene.add(new Node({ tag: 'button', role: 'heading', label: 'Title' }));
    const found = auditA11y(scene).filter((f) => f.kind === 'role-tag-conflict');
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain('loses its button semantics');
  });

  it('stays quiet when role matches the tag implicitly', () => {
    const scene = makeScene();
    scene.add(new Node({ tag: 'button', role: 'button', label: 'OK' }));
    expect(kinds(auditA11y(scene))).not.toContain('role-tag-conflict');
  });

  it('stays quiet for a tag with no implicit role', () => {
    const scene = makeScene();
    scene.add(new Node({ tag: 'div', role: 'tablist', label: 'Tabs' }));
    expect(kinds(auditA11y(scene))).not.toContain('role-tag-conflict');
  });
});

describe('auditA11y: disabled-divergence', () => {
  it('fires when a dimmed control is still projected as enabled', () => {
    const scene = makeScene();
    const node = new Node({ tag: 'button', label: 'Submit' });
    node.interactive = true;
    node.opacity = 0.4;
    scene.add(node);
    const found = auditA11y(scene).filter((f) => f.kind === 'disabled-divergence');
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain('projected as enabled');
  });

  it('fires in the opposite direction too', () => {
    const scene = makeScene();
    const node = new Node({ tag: 'button', label: 'Submit', disabled: true });
    node.opacity = 1;
    scene.add(node);
    const found = auditA11y(scene).filter((f) => f.kind === 'disabled-divergence');
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain('painted fully opaque');
  });

  it('stays quiet when dimming and disabled agree', () => {
    const scene = makeScene();
    const node = new Node({ tag: 'button', label: 'Submit', disabled: true });
    node.opacity = 0.4;
    scene.add(node);
    expect(kinds(auditA11y(scene))).not.toContain('disabled-divergence');
  });
});

describe('auditA11y: focusable-but-clipped', () => {
  it('fires when a focusable node is clipped fully out of view', () => {
    const scene = makeScene();
    const clipper = new Node({});
    clipper.width = 100;
    clipper.height = 100;
    clipper.clipChildren = true;
    const hidden = new Node({ tag: 'button', label: 'Off screen' });
    hidden.interactive = true;
    // Positioned entirely outside the clip box: Tab still reaches it.
    hidden.x = 500;
    hidden.y = 500;
    clipper.add(hidden);
    scene.add(clipper);
    const found = auditA11y(scene).filter((f) => f.kind === 'focusable-but-clipped');
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain('somewhere invisible');
    expect(found[0]!.containerId).toBe(clipper.id);
  });

  it('stays quiet when the node is inside its clipper', () => {
    const scene = makeScene();
    const clipper = new Node({});
    clipper.width = 100;
    clipper.height = 100;
    clipper.clipChildren = true;
    const visible = new Node({ tag: 'button', label: 'In view' });
    visible.interactive = true;
    clipper.add(visible);
    scene.add(clipper);
    expect(kinds(auditA11y(scene))).not.toContain('focusable-but-clipped');
  });
});

describe('auditA11y: duplicate-label', () => {
  it('fires for focusable nodes sharing an accessible name', () => {
    const scene = makeScene();
    for (let i = 0; i < 3; i++) {
      const node = new Node({ tag: 'button', label: 'Delete' });
      node.interactive = true;
      node.y = i * 30;
      scene.add(node);
    }
    const found = auditA11y(scene).filter((f) => f.kind === 'duplicate-label');
    // Reported against the second onward: flagging all three would turn an N-row
    // list into N findings for one problem.
    expect(found).toHaveLength(2);
    expect(found[0]!.message).toContain('cannot tell them apart');
  });

  it('stays quiet when names differ', () => {
    const scene = makeScene();
    for (const label of ['Delete row 1', 'Delete row 2']) {
      const node = new Node({ tag: 'button', label });
      node.interactive = true;
      scene.add(node);
    }
    expect(kinds(auditA11y(scene))).not.toContain('duplicate-label');
  });

  it('ignores duplicates among non-focusable nodes', () => {
    const scene = makeScene();
    scene.add(new Node({ tag: 'span', label: 'Total' }));
    scene.add(new Node({ tag: 'span', label: 'Total' }));
    expect(kinds(auditA11y(scene))).not.toContain('duplicate-label');
  });
});

describe('auditA11y scoping', () => {
  it('skips an a11yHidden subtree', () => {
    const scene = makeScene();
    const hidden = new Node({});
    hidden.a11yHidden = true;
    const button = new Node({ tag: 'button', role: 'button' });
    button.interactive = true;
    hidden.add(button);
    scene.add(hidden);
    // A hidden subtree does not project, so reporting it would flag a defect no
    // user can reach.
    expect(auditA11y(scene)).toHaveLength(0);
  });

  it('honours the skip option', () => {
    const scene = makeScene();
    const button = new Node({ tag: 'button', role: 'button' });
    button.interactive = true;
    scene.add(button);
    expect(auditA11y(scene, { skip: ['no-accessible-name'] })).toHaveLength(0);
  });
});

describe('a11yReadingOrder', () => {
  it('lists only projected entities', () => {
    const scene = makeScene();
    scene.add(new Node({ tag: 'button', label: 'One' }));
    scene.add(new Node({}));
    scene.add(new Node({ tag: 'button', label: 'Two' }));
    const order = a11yReadingOrder(scene);
    expect(order.map((i) => i.accessibleName)).toEqual(['One', 'Two']);
  });
});

describe('a11y name resolution robustness', () => {
  it('ignores a non-string label instead of formatting an object as the name', () => {
    // A11yAttributes.label is typed string, but a component that forwards its
    // whole options object by mistake lands here. Without a guard the audit
    // compares objects for duplicate names and renders one into a panel row.
    class Bad extends Entity {
      public override getA11yAttributes(): A11yAttributes {
        return { tag: 'button', label: { label: 'Delete' } as unknown as string };
      }
      public override render(): void {}
    }
    const scene = makeScene();
    const bad = new Bad();
    bad.interactive = true;
    scene.add(bad);
    const info = inspectA11y(scene, bad);
    expect(info.accessibleName).toBeUndefined();
    expect(info.nameSource).toBe('none');
    // And it is reported as unnamed, which is the truth for a screen reader.
    expect(auditA11y(scene).map((f) => f.kind)).toContain('no-accessible-name');
  });
});
