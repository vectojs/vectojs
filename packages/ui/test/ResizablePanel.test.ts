// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Entity } from '@vectojs/core';
import { Panel, PanelGroup, PanelResizeHandle } from '../src/ResizablePanel';

class Leaf extends Entity {
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

describe('Panel.setContent fitContent contract', () => {
  it('defaults to fitting both width and height to the panel box', () => {
    const panel = new Panel();
    panel.width = 300;
    panel.height = 200;
    const content = new Leaf();
    panel.setContent(content);

    expect(content.width).toBe(300);
    expect(content.height).toBe(200);
  });

  it('fit=false keeps the old position-only behavior (content size untouched)', () => {
    const panel = new Panel();
    panel.width = 300;
    panel.height = 200;
    const content = new Leaf();
    content.width = 50;
    content.height = 40;
    panel.setContent(content, false);

    expect(content.width).toBe(50);
    expect(content.height).toBe(40);
    // Position is still applied even when fit is off.
    expect(content.x).toBe(0);
    expect(content.y).toBe(0);
  });

  it('per-axis fit tracks only the requested axis', () => {
    const panel = new Panel();
    panel.width = 300;
    panel.height = 200;
    const content = new Leaf();
    content.width = 50;
    content.height = 40;
    panel.setContent(content, { width: true, height: false });

    expect(content.width).toBe(300);
    expect(content.height).toBe(40);
  });

  it('re-applies the fit on every update(), not just at setContent() time', () => {
    const panel = new Panel();
    panel.width = 300;
    panel.height = 200;
    const content = new Leaf();
    panel.setContent(content);
    expect(content.width).toBe(300);

    // Simulate an external resize of the panel itself, as PanelGroup._layout
    // does every drag/resize — Panel has no width/height setter to hook, so
    // the fit is only re-applied on the next update() tick.
    panel.width = 150;
    expect(content.width).toBe(300); // not yet re-applied
    panel.update(16, 16);
    expect(content.width).toBe(150); // caught up on the next frame
  });

  it('replacing content clears the previous content from the tree', () => {
    const panel = new Panel();
    panel.width = 100;
    panel.height = 100;
    const first = new Leaf();
    const second = new Leaf();
    panel.setContent(first);
    expect(panel.children).toContain(first);
    panel.setContent(second);
    expect(panel.children).not.toContain(first);
    expect(panel.children).toContain(second);
  });
});

describe('PanelGroup -> Panel -> content resize propagation (findings.md, 2026-07-10)', () => {
  // The original vem repro chain was WorkspaceExplorer -> Panel -> Tabs ->
  // WorkspaceLayout: PanelGroup correctly resized its Panel children, but
  // Panel never resized the content it hosted, so a hand-missed sync call
  // let a tab layout bleed 3.2px past its Panel's clip. This test drives
  // the exact same chain end-to-end (PanelGroup divider drag AND
  // PanelGroup.resize()) and asserts the hosted content's box always
  // matches its Panel's post-resize box, with NO manual sync call from the
  // test itself.
  it('drag-resizing a PanelGroup divider resizes each panel AND its hosted content', () => {
    const group = new PanelGroup({ direction: 'horizontal', width: 400, height: 200 });
    const left = new Panel({ minSize: 60 });
    const right = new Panel({ minSize: 60 });
    const leftContent = new Leaf();
    const rightContent = new Leaf();
    left.setContent(leftContent);
    right.setContent(rightContent);
    group.addPanel(left).addPanel(right);

    // Drive a frame so Panel.update() has run at least once post-layout.
    left.update(16, 16);
    right.update(16, 16);
    expect(leftContent.width).toBe(left.width);
    expect(rightContent.width).toBe(right.width);

    const handle = group.children.find((c) => c instanceof PanelResizeHandle) as
      PanelResizeHandle | undefined;
    expect(handle).toBeTruthy();
    // Simulate a drag: PanelResizeHandle's pointerdown/pointermove handlers
    // call the group's private _onResize through the onResize callback
    // passed at construction — exercise the same public surface a real
    // pointer drag would, via the handle's own pointer events.
    handle!.emit('pointerdown', { sceneX: handle!.x, sceneY: 0 });
    handle!.emit('pointermove', { sceneX: handle!.x + 40, sceneY: 0 });
    handle!.emit('pointerup', {});

    left.update(16, 16);
    right.update(16, 16);
    expect(leftContent.width, 'left content must track its panel after a divider drag').toBe(
      left.width,
    );
    expect(rightContent.width, 'right content must track its panel after a divider drag').toBe(
      right.width,
    );
    expect(leftContent.height).toBe(left.height);
    expect(rightContent.height).toBe(right.height);
  });

  it('PanelGroup.resize() (e.g. a window resize) resizes panels AND their hosted content', () => {
    const group = new PanelGroup({ direction: 'vertical', width: 300, height: 400 });
    const top = new Panel({ minSize: 60 });
    const bottom = new Panel({ minSize: 60 });
    const topContent = new Leaf();
    const bottomContent = new Leaf();
    top.setContent(topContent);
    bottom.setContent(bottomContent);
    group.addPanel(top).addPanel(bottom);

    group.resize(300, 800);
    top.update(16, 16);
    bottom.update(16, 16);

    expect(topContent.height, 'top content must track its panel after group.resize()').toBe(
      top.height,
    );
    expect(bottomContent.height, 'bottom content must track its panel after group.resize()').toBe(
      bottom.height,
    );
  });
});
