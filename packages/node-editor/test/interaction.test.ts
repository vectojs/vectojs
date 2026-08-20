import { describe, expect, it } from 'vitest';
import { VectoJSEvent } from '@vectojs/core';
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
});
