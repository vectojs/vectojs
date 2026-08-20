import { describe, expect, it } from 'vitest';
import { CommandHistory } from '../src/history';
import type { NodeDocument } from '../src/model';

const initial: NodeDocument = {
  nodes: [{ id: 'a', type: 'input', title: 'A', position: { x: 0, y: 0 } }],
  links: [],
};

describe('command history', () => {
  it('undoes and redoes commands, clearing redo after a new command', () => {
    const history = new CommandHistory(initial);
    const moved = { nodes: [{ ...initial.nodes[0], position: { x: 10, y: 20 } }], links: [] };
    history.execute('Move node', moved);
    expect(history.undo().nodes[0].position).toEqual({ x: 0, y: 0 });
    expect(history.canRedo).toBe(true);
    expect(history.redo().nodes[0].position).toEqual({ x: 10, y: 20 });
    history.undo();
    history.execute('Move again', initial);
    expect(history.canRedo).toBe(false);
  });

  it('stores link creation and deletion as commands', () => {
    const history = new CommandHistory(initial);
    const linked = {
      ...initial,
      links: [{ id: 'l1', source: 'a', target: 'b', sourcePort: 'out', targetPort: 'in' }],
    };
    history.execute('Create link', linked);
    expect(history.document.links).toHaveLength(1);
    history.execute('Delete link', initial);
    expect(history.undo().links).toHaveLength(1);
    expect(history.redo().links).toHaveLength(0);
  });
});
