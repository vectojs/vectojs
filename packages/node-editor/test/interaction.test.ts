/**
 * Tests drive the same event shapes production routing produces:
 * core forwards the real DOM event as `nativeEvent`, so keyboard-synthesized
 * clicks carry a KeyboardEvent (the keydown that triggered them) while native
 * hotspot clicks carry a MouseEvent.
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { Entity, VectoJSEvent } from '@vectojs/core';
import { NodeEditor } from '../src/editor';

function event(
  editor: NodeEditor,
  type: string,
  x: number,
  y: number,
  nativeEvent: Record<string, unknown> = {},
) {
  return new VectoJSEvent(type as any, editor, { ...nativeEvent, vectoSceneX: x, vectoSceneY: y });
}

/** Native shape of a core-synthesized click (the keydown itself, Scene.ts:3665). */
const keyActivate = () => new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });

/** Native shape of a browser click on the projected hotspot mirror (Scene.ts:3472). */
const pointerClick = () => new MouseEvent('click', { bubbles: true });

function findEntity(root: Entity, id: string): Entity | undefined {
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findEntity(child, id);
    if (found) return found;
  }
  return undefined;
}

const connectedDocument = () => ({
  nodes: [
    {
      id: 'source',
      type: 'source',
      title: 'Source',
      position: { x: 0, y: 0 },
      ports: [{ id: 'out', direction: 'output' as const, dataType: 'number' }],
    },
    {
      id: 'target',
      type: 'target',
      title: 'Target',
      position: { x: 200, y: 0 },
      ports: [{ id: 'in', direction: 'input' as const, dataType: 'number' }],
    },
  ],
  links: [],
});

describe('node editor interaction', () => {
  it('commits a pointer drag as one undoable command', () => {
    const editor = new NodeEditor({
      document: {
        nodes: [{ id: 'a', type: 'input', title: 'A', position: { x: 10, y: 20 } }],
        links: [],
      },
    });
    editor.beginDrag('a', event(editor, 'pointerdown', 100, 100));
    editor.moveDrag(event(editor, 'pointermove', 130, 145));
    editor.endDrag(event(editor, 'pointerup', 130, 145));
    expect(editor.document.nodes[0].position).toEqual({ x: 40, y: 65 });
    expect(editor.canUndo).toBe(true);
    editor.undo();
    expect(editor.document.nodes[0].position).toEqual({ x: 10, y: 20 });
  });

  it('supports additive selection and cancel rollback', () => {
    const editor = new NodeEditor({
      document: {
        nodes: [
          { id: 'a', type: 'input', title: 'A', position: { x: 0, y: 0 } },
          { id: 'b', type: 'output', title: 'B', position: { x: 200, y: 0 } },
        ],
        links: [],
      },
    });
    editor.select('a');
    editor.select('b', true);
    expect(editor.selection.selectedIds).toEqual(['a', 'b']);
    editor.beginDrag('a', event(editor, 'pointerdown', 10, 10));
    editor.moveDrag(event(editor, 'pointermove', 50, 50));
    editor.cancelDrag();
    expect(editor.document.nodes[0].position).toEqual({ x: 0, y: 0 });
  });

  it('creates valid links and rejects invalid pointer targets', () => {
    const editor = new NodeEditor({ document: connectedDocument() });
    editor.beginConnection('source', 'out', event(editor, 'pointerdown', 180, 30));
    editor.endConnection(event(editor, 'pointerup', 190, 30));
    expect(editor.document.links).toHaveLength(0);
    editor.beginConnection('source', 'out', event(editor, 'pointerdown', 174, 30));
    editor.endConnection(event(editor, 'pointerup', 194, 30));
    expect(editor.document.links).toHaveLength(1);
    expect(editor.canUndo).toBe(true);
    editor.undo();
    expect(editor.document.links).toHaveLength(0);
  });

  it('cancels a connection without changing history', () => {
    const editor = new NodeEditor({
      document: {
        nodes: [
          {
            id: 'source',
            type: 'source',
            title: 'Source',
            position: { x: 0, y: 0 },
            ports: [{ id: 'out', direction: 'output' }],
          },
        ],
        links: [],
      },
    });
    editor.beginConnection('source', 'out', event(editor, 'pointerdown', 174, 30));
    editor.cancelConnection();
    expect(editor.document.links).toHaveLength(0);
    expect(editor.canUndo).toBe(false);
  });
  it('connects ports via keyboard activation (Enter on output, Enter on input)', () => {
    const editor = new NodeEditor({ document: connectedDocument() });
    const outPort = findEntity(editor, 'port:source:out');
    const inPort = findEntity(editor, 'port:target:in');
    expect(outPort).toBeDefined();
    expect(inPort).toBeDefined();
    outPort!.dispatchEvent(new VectoJSEvent('click', outPort!, keyActivate()));
    expect(editor.isConnectionTarget('target', 'in')).toBe(true);
    inPort!.dispatchEvent(new VectoJSEvent('click', inPort!, keyActivate()));
    expect(editor.document.links).toHaveLength(1);
    expect(editor.document.links[0]).toMatchObject({
      source: 'source',
      sourcePort: 'out',
      target: 'target',
      targetPort: 'in',
    });
    expect(editor.canUndo).toBe(true);
    editor.undo();
    expect(editor.document.links).toHaveLength(0);
  });

  it('escape cancels a keyboard-started connection without history', () => {
    const editor = new NodeEditor({ document: connectedDocument() });
    const outPort = findEntity(editor, 'port:source:out')!;
    outPort.dispatchEvent(new VectoJSEvent('click', outPort, keyActivate()));
    expect(editor.isConnectionTarget('target', 'in')).toBe(true);
    editor.emit('keydown', new VectoJSEvent('keydown', editor, { key: 'Escape' }));
    expect(editor.isConnectionTarget('target', 'in')).toBe(false);
    expect(editor.document.links).toHaveLength(0);
    expect(editor.canUndo).toBe(false);
  });

  it('ignores input-port activation with no pending connection', () => {
    const editor = new NodeEditor({ document: connectedDocument() });
    const inPort = findEntity(editor, 'port:target:in')!;
    inPort.dispatchEvent(new VectoJSEvent('click', inPort, keyActivate()));
    expect(editor.document.links).toHaveLength(0);
    expect(editor.canUndo).toBe(false);
  });

  it('never arms a connection from a pointer click on a port hotspot', () => {
    const editor = new NodeEditor({ document: connectedDocument() });
    const outPort = findEntity(editor, 'port:source:out')!;
    const inPort = findEntity(editor, 'port:target:in')!;
    // A bare browser click on the output port mirror must not start the
    // keyboard gesture: otherwise an innocent later input-port activation
    // commits a link the user never asked for.
    outPort.dispatchEvent(new VectoJSEvent('click', outPort, pointerClick()));
    expect(editor.isConnectionTarget('target', 'in')).toBe(false);
    expect(editor.isConnectionTarget('target', 'in')).toBe(false);
    inPort.dispatchEvent(new VectoJSEvent('click', inPort, pointerClick()));
    expect(editor.document.links).toHaveLength(0);
    expect(editor.canUndo).toBe(false);
  });

  it('a cancelled connect drag stays cancelled despite the capture-retargeted click', () => {
    const editor = new NodeEditor({ document: connectedDocument() });
    const outPort = findEntity(editor, 'port:source:out')!;
    const inPort = findEntity(editor, 'port:target:in')!;
    // Drag out of the output port and release over empty space: endConnection
    // cancels, then the mirror's pointer capture retargets the browser click
    // to the port (Scene.ts:3521) — that native click must not re-arm.
    editor.beginConnection('source', 'out', event(editor, 'pointerdown', 180, 30));
    editor.endConnection(event(editor, 'pointerup', 500, 500));
    expect(editor.isConnectionTarget('target', 'in')).toBe(false);
    outPort.dispatchEvent(new VectoJSEvent('click', outPort, pointerClick()));
    expect(editor.isConnectionTarget('target', 'in')).toBe(false);
    expect(editor.isConnectionTarget('target', 'in')).toBe(false);
    // And it must not turn a later input-port click into a committed link.
    inPort.dispatchEvent(new VectoJSEvent('click', inPort, pointerClick()));
    expect(editor.document.links).toHaveLength(0);
    expect(editor.canUndo).toBe(false);
  });

  it('escape cancels a pending connection while focus is on a port hotspot', () => {
    const editor = new NodeEditor({ document: connectedDocument() });
    const outPort = findEntity(editor, 'port:source:out')!;
    const inPort = findEntity(editor, 'port:target:in')!;
    outPort.dispatchEvent(new VectoJSEvent('click', outPort, keyActivate()));
    expect(editor.isConnectionTarget('target', 'in')).toBe(true);
    // During the gesture focus rests on the port hotspot mirror, so core
    // routes Escape keydown to the PORT entity, not the editor. The editor is
    // an entity-tree ancestor of the port, so dispatching at the port walks
    // target -> root exactly as production routing does.
    outPort.dispatchEvent(
      new VectoJSEvent(
        'keydown',
        outPort,
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    expect(editor.isConnectionTarget('target', 'in')).toBe(false);
    expect(editor.isConnectionTarget('target', 'in')).toBe(false);
    inPort.dispatchEvent(new VectoJSEvent('click', inPort, keyActivate()));
    expect(editor.document.links).toHaveLength(0);
    expect(editor.canUndo).toBe(false);
  });

  it('drags at correct speed under a scaled and translated ancestor', () => {
    const editor = new NodeEditor({
      document: {
        nodes: [{ id: 'a', type: 'input', title: 'A', position: { x: 10, y: 20 } }],
        links: [],
      },
    });
    editor.scaleX = 0.5;
    editor.scaleY = 0.5;
    editor.x = 100;
    editor.y = 50;
    // Scene point for an editor-local point under scale 0.5 + translate (100, 50).
    const scenePoint = (localX: number, localY: number) => ({
      x: localX * 0.5 + 100,
      y: localY * 0.5 + 50,
    });
    editor.beginDrag('a', event(editor, 'pointerdown', scenePoint(0, 0).x, scenePoint(0, 0).y));
    editor.moveDrag(event(editor, 'pointermove', scenePoint(30, 45).x, scenePoint(30, 45).y));
    editor.endDrag(event(editor, 'pointerup', scenePoint(30, 45).x, scenePoint(30, 45).y));
    expect(editor.document.nodes[0].position).toEqual({ x: 40, y: 65 });
  });

  it('targets ports by document-local coordinates under a transformed ancestor', () => {
    const editor = new NodeEditor({ document: connectedDocument() });
    editor.scaleX = 0.5;
    editor.scaleY = 0.5;
    editor.x = 100;
    editor.y = 50;
    const scenePoint = (localX: number, localY: number) => ({
      x: localX * 0.5 + 100,
      y: localY * 0.5 + 50,
    });
    // Source output port box is local (174..186, 24..36); the target node sits
    // at (200, 0), so its input port box is local (194..206, 24..36).
    editor.beginConnection(
      'source',
      'out',
      event(editor, 'pointerdown', scenePoint(180, 30).x, scenePoint(180, 30).y),
    );
    editor.endConnection(event(editor, 'pointerup', scenePoint(200, 30).x, scenePoint(200, 30).y));
    expect(editor.document.links).toHaveLength(1);
  });

  it('cancels the active drag before applying undo or redo', () => {
    const editor = new NodeEditor({
      document: {
        nodes: [{ id: 'a', type: 'input', title: 'A', position: { x: 10, y: 20 } }],
        links: [],
      },
    });
    editor.beginDrag('a', event(editor, 'pointerdown', 100, 100));
    editor.moveDrag(event(editor, 'pointermove', 150, 150));
    editor.emit('keydown', new VectoJSEvent('keydown', editor, { key: 'z', ctrlKey: true }));
    // Nothing was committed yet, so undo is a no-op; the drag must be aborted
    // rather than left holding a stale origin that teleports the node.
    expect(editor.document.nodes[0].position).toEqual({ x: 10, y: 20 });
    expect(editor.selection.drag).toBeNull();
    editor.moveDrag(event(editor, 'pointermove', 200, 200));
    editor.endDrag(event(editor, 'pointerup', 200, 200));
    expect(editor.document.nodes[0].position).toEqual({ x: 10, y: 20 });
    expect(editor.canUndo).toBe(false);
  });

  it('applies auto-layout as one undoable command', () => {
    const editor = new NodeEditor({
      document: {
        nodes: [
          { id: 'target', type: 'target', title: 'Target', position: { x: 300, y: 300 } },
          { id: 'source', type: 'source', title: 'Source', position: { x: 300, y: 300 } },
        ],
        links: [{ id: 'link', source: 'source', target: 'target' }],
      },
    });
    editor.applyAutoLayout({ originX: 10, originY: 20 });
    expect(editor.document.nodes.map((node) => node.position)).toEqual([
      { x: 270, y: 20 },
      { x: 10, y: 20 },
    ]);
    expect(editor.canUndo).toBe(true);
    editor.undo();
    expect(editor.document.nodes.map((node) => node.position)).toEqual([
      { x: 300, y: 300 },
      { x: 300, y: 300 },
    ]);
  });
});
