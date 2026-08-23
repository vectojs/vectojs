import { Entity, type IRenderer, type VectoJSEvent } from '@vectojs/core';
import { UIComponent } from '@vectojs/ui';
import { CommandHistory } from './history';
import {
  cloneDocument,
  addLink,
  getPort,
  getNode,
  removeLink,
  updateNodePosition,
  type LinkData,
  type NodeData,
  type NodeDocument,
  type PortDefinition,
} from './model';
import { SelectionState } from './selection';
import { layoutDocument, type AutoLayoutOptions } from './layout';

const NODE_WIDTH = 180;
const NODE_HEIGHT = 76;
const PORT_SIZE = 12;

class PortEntity extends UIComponent {
  public width = PORT_SIZE;
  public height = PORT_SIZE;
  public constructor(
    private readonly node: NodeData,
    private readonly port: PortDefinition,
    private readonly editor: NodeEditor,
    index: number,
  ) {
    super(`port:${node.id}:${port.id}`);
    this.interactive = true;
    this.setPosition(
      port.direction === 'output' ? (node.width ?? NODE_WIDTH) - PORT_SIZE / 2 : -PORT_SIZE / 2,
      24 + index * 20,
    );
    this.on('pointerdown', (event: VectoJSEvent) => {
      event.stopPropagation();
      editor.beginConnection(node.id, port.id, event);
    });
    this.on('pointermove', (event: VectoJSEvent) => {
      event.stopPropagation();
      editor.moveConnection(event);
    });
    this.on('pointerup', (event: VectoJSEvent) => {
      event.stopPropagation();
      editor.endConnection(event);
    });
    this.on('pointercancel', (event: VectoJSEvent) => {
      event.stopPropagation();
      editor.cancelConnection();
    });
    // Keyboard parity (WCAG 2.1.1): the hotspot advertises role="button", so
    // core synthesizes `click` from Enter/Space on focus — route it into the
    // same connection gesture the pointer uses. Provenance matters: core also
    // dispatches entity `click` for native browser clicks on this mirror
    // (pointer capture retargets a released connect-drag back onto it), and
    // those must not mutate connection state — the pointer handlers above own
    // it. A synthesized click carries the keydown itself as nativeEvent, so a
    // real KeyboardEvent instance identifies the keyboard path.
    this.on('click', (event: VectoJSEvent) => {
      if (!(event.nativeEvent instanceof KeyboardEvent)) return;
      event.stopPropagation();
      editor.portActivated(node.id, port.id);
    });
  }
  public isPointInside(globalX: number, globalY: number): boolean {
    const point = this.worldToLocal(globalX, globalY);
    return (
      !!point && point.x >= 0 && point.x <= this.width && point.y >= 0 && point.y <= this.height
    );
  }
  public getBounds() {
    return { x: 0, y: 0, width: this.width, height: this.height };
  }
  public getA11yAttributes() {
    return {
      role: 'button',
      label: `${this.port.label ?? this.port.id} ${this.port.direction} port on ${this.node.title}`,
      tabIndex: 0,
    };
  }
  public render(r: IRenderer): void {
    r.beginPath();
    r.arc(PORT_SIZE / 2, PORT_SIZE / 2, PORT_SIZE / 2, 0, Math.PI * 2);
    r.fill(this.editor.isConnectionTarget(this.node.id, this.port.id) ? '#fbbf24' : '#38bdf8');
  }
}

class LinkEntity extends Entity {
  public constructor(
    private readonly link: LinkData,
    private readonly nodes: Map<string, NodeCard>,
  ) {
    super(`link:${link.id}`);
  }
  public isPointInside(): boolean {
    return false;
  }
  public getBounds() {
    return null;
  }
  public render(r: IRenderer): void {
    const source = this.nodes.get(this.link.source);
    const target = this.nodes.get(this.link.target);
    if (!source || !target) return;
    r.beginPath();
    r.moveTo(source.x + source.width, source.y + source.height / 2);
    r.lineTo(target.x, target.y + target.height / 2);
    r.stroke('#64748b', 2);
  }
}

class NodeCard extends UIComponent {
  public width: number;
  public height: number;
  public constructor(
    public readonly node: NodeData,
    private readonly editor: NodeEditor,
  ) {
    super(`node:${node.id}`);
    this.width = node.width ?? NODE_WIDTH;
    this.height = node.height ?? NODE_HEIGHT;
    this.setPosition(node.position.x, node.position.y);
    this.interactive = true;
    this.on('pointerdown', (event: VectoJSEvent) => editor.beginDrag(node.id, event));
    this.on('pointermove', (event: VectoJSEvent) => editor.moveDrag(event));
    this.on('pointerup', (event: VectoJSEvent) => editor.endDrag(event));
    this.on('pointercancel', () => editor.cancelDrag());
    this.on('click', (event: VectoJSEvent) =>
      editor.select(node.id, event.shiftKey || event.metaKey || event.ctrlKey),
    );
    for (const [index, port] of (node.ports ?? []).entries())
      this.add(new PortEntity(node, port, editor, index));
  }
  public isPointInside(globalX: number, globalY: number): boolean {
    const point = this.worldToLocal(globalX, globalY);
    return (
      !!point && point.x >= 0 && point.x <= this.width && point.y >= 0 && point.y <= this.height
    );
  }
  public getBounds() {
    return { x: 0, y: 0, width: this.width, height: this.height };
  }
  public getA11yAttributes() {
    return {
      role: 'button',
      label: `${this.node.title}, ${this.node.type}`,
      selected: this.editor.selection.has(this.node.id),
      tabIndex: this.editor.selection.has(this.node.id) ? 0 : -1,
    };
  }
  public render(r: IRenderer): void {
    const selected = this.editor.selection.has(this.node.id);
    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, 10);
    r.fill(selected ? '#1e3a8a' : '#172033');
    r.stroke(selected ? '#60a5fa' : '#475569', selected ? 2 : 1);
    r.fillText(this.node.title, 14, 30, '600 16px sans-serif', '#f8fafc');
    r.fillText(this.node.type, 14, 54, '13px sans-serif', '#94a3b8');
  }
}

export interface NodeEditorOptions {
  document?: NodeDocument;
  width?: number;
  height?: number;
}

export class NodeEditor extends Entity {
  public readonly selection = new SelectionState();
  private readonly history: CommandHistory;
  private readonly nodeEntities = new Map<string, NodeCard>();
  private readonly linkEntities = new Map<string, LinkEntity>();
  private dragDocument: NodeDocument | null = null;
  private connection: { nodeId: string; portId: string } | null = null;
  private connectionPoint: { x: number; y: number } | null = null;
  private documentState: NodeDocument;
  public width: number;
  public height: number;

  public constructor(options: NodeEditorOptions = {}) {
    super('node-editor');
    this.width = options.width ?? 1000;
    this.height = options.height ?? 700;
    this.documentState = createSafeDocument(options.document);
    this.history = new CommandHistory(this.documentState);
    this.interactive = true;
    this.a11yRegion = true;
    this.on('keydown', (event: VectoJSEvent) => this.handleKeyDown(event));
    this.rebuild();
  }

  public get document(): NodeDocument {
    return cloneDocument(this.documentState);
  }
  public get canUndo(): boolean {
    return this.history.canUndo;
  }
  public get canRedo(): boolean {
    return this.history.canRedo;
  }

  public getA11yAttributes() {
    return { role: 'region', label: 'Node editor', tabIndex: 0 };
  }
  public isPointInside(globalX: number, globalY: number): boolean {
    const point = this.worldToLocal(globalX, globalY);
    return (
      !!point && point.x >= 0 && point.x <= this.width && point.y >= 0 && point.y <= this.height
    );
  }
  public getBounds() {
    return { x: 0, y: 0, width: this.width, height: this.height };
  }
  public render(r: IRenderer): void {
    if (!this.connection || !this.connectionPoint) return;
    const source = getNode(this.documentState, this.connection.nodeId);
    const sourcePort = getPort(source, this.connection.portId);
    if (!source || !sourcePort) return;
    const sourceX = source.position.x + (source.width ?? NODE_WIDTH);
    const sourceY =
      source.position.y +
      30 +
      (source.ports ?? []).findIndex((port) => port.id === sourcePort.id) * 20;
    r.beginPath();
    r.moveTo(sourceX, sourceY);
    r.lineTo(this.connectionPoint.x, this.connectionPoint.y);
    r.stroke('#fbbf24', 2);
  }

  public select(id: string, additive = false): void {
    this.selection.select(id, additive);
    this.scene?.markDirty();
  }

  public undo(): void {
    this.applyDocument(this.history.undo());
  }
  public redo(): void {
    this.applyDocument(this.history.redo());
  }

  public applyAutoLayout(options: AutoLayoutOptions = {}): NodeDocument {
    const next = layoutDocument(this.documentState, options);
    if (JSON.stringify(next) !== JSON.stringify(this.documentState)) {
      this.history.execute('Auto-layout', next);
      this.applyDocument(this.history.currentDocument);
    }
    return this.document;
  }
  public beginConnection(nodeId: string, portId: string, event: VectoJSEvent): void {
    const node = getNode(this.documentState, nodeId);
    const port = getPort(node, portId);
    if (!node || !port || port.direction !== 'output') return;
    this.connection = { nodeId, portId };
    this.connectionPoint = this.getLocalPoint(event);
    this.scene?.markDirty();
  }

  /**
   * Keyboard connection gesture (WCAG 2.1.1): activating an output port starts
   * a pending connection; activating an input port commits it. Escape cancels
   * via the editor keydown handler. Core synthesizes `click` from Enter/Space
   * on the focused port hotspot.
   */
  public portActivated(nodeId: string, portId: string): void {
    const node = getNode(this.documentState, nodeId);
    const port = getPort(node, portId);
    if (!node || !port) return;
    if (port.direction === 'output') {
      // No pointer is attached to a keyboard gesture, so no rubber line point.
      this.connection = { nodeId, portId };
      this.connectionPoint = null;
      this.scene?.markDirty();
      return;
    }
    if (this.connection) this.commitLink({ nodeId, portId });
  }

  public moveConnection(event: VectoJSEvent): void {
    if (!this.connection) return;
    this.connectionPoint = this.getLocalPoint(event);
    this.scene?.markDirty();
  }

  public endConnection(event: VectoJSEvent): void {
    if (!this.connection) return;
    const point = this.getLocalPoint(event);
    if (!point) {
      this.cancelConnection();
      return;
    }
    const target = this.findPortAt(point);
    if (target) this.commitLink(target);
    else this.cancelConnection();
  }

  private commitLink(target: { nodeId: string; portId: string }): void {
    if (!this.connection) return;
    const link: LinkData = {
      id: `link:${this.connection.nodeId}:${this.connection.portId}:${target.nodeId}:${target.portId}`,
      source: this.connection.nodeId,
      sourcePort: this.connection.portId,
      target: target.nodeId,
      targetPort: target.portId,
    };
    try {
      this.createLink(link);
    } catch {
      // Invalid targets cancel the transient connection without history.
    }
    this.cancelConnection();
  }

  public cancelConnection(): void {
    this.connection = null;
    this.connectionPoint = null;
    this.scene?.markDirty();
  }

  public isConnectionTarget(nodeId: string, portId: string): boolean {
    if (!this.connection) return false;
    const node = getNode(this.documentState, nodeId);
    const port = getPort(node, portId);
    if (!port || port.direction !== 'input') return false;
    return validateConnection(this.documentState, {
      id: 'preview',
      source: this.connection.nodeId,
      sourcePort: this.connection.portId,
      target: nodeId,
      targetPort: portId,
    });
  }

  public deleteLink(id: string): void {
    if (!this.documentState.links.some((link) => link.id === id)) return;
    this.history.execute('Delete link', removeLink(this.documentState, id));
    this.applyDocument(this.history.currentDocument);
  }

  public createLink(link: LinkData): void {
    this.history.execute('Create link', addLink(this.documentState, link));
    this.applyDocument(this.history.currentDocument);
  }

  public beginDrag(id: string, event: VectoJSEvent): void {
    const node = getNode(this.documentState, id);
    const point = this.getLocalPoint(event);
    if (!node || !point) return;
    this.select(id, event.shiftKey || event.metaKey || event.ctrlKey);
    this.dragDocument = cloneDocument(this.documentState);
    this.selection.drag = {
      nodeId: id,
      originX: node.position.x,
      originY: node.position.y,
      pointerX: point.x,
      pointerY: point.y,
    };
  }

  public moveDrag(event: VectoJSEvent): void {
    const drag = this.selection.drag;
    const point = this.getLocalPoint(event);
    if (!drag || !point) return;
    const position = {
      x: drag.originX + point.x - drag.pointerX,
      y: drag.originY + point.y - drag.pointerY,
    };
    this.applyPreview(updateNodePosition(this.documentState, drag.nodeId, position));
  }

  public endDrag(event: VectoJSEvent): void {
    if (!this.selection.drag) return;
    this.moveDrag(event);
    const before = this.dragDocument ?? this.documentState;
    const changed = JSON.stringify(before) !== JSON.stringify(this.documentState);
    if (changed) this.history.execute('Move node', this.documentState);
    this.dragDocument = null;
    this.selection.drag = null;
    this.scene?.markDirty();
  }

  public cancelDrag(): void {
    if (!this.dragDocument) return;
    this.applyPreview(this.dragDocument);
    this.dragDocument = null;
    this.selection.drag = null;
  }

  private handleKeyDown(event: VectoJSEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelConnection();
      this.cancelDrag();
      return;
    }
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && (event.key?.toLowerCase() === 'z' || event.key?.toLowerCase() === 'y')) {
      event.preventDefault();
      // Undo/redo rebuilds the tree under an active gesture; a stale drag
      // origin would teleport the node and commit a bogus history entry.
      // End transient interactions first, mirroring the Escape path above.
      this.cancelConnection();
      this.cancelDrag();
      if (event.key?.toLowerCase() === 'y' || event.shiftKey) this.redo();
      else this.undo();
    }
  }

  private applyPreview(document: NodeDocument): void {
    this.documentState = cloneDocument(document);
    this.syncPositions();
    this.scene?.markDirty();
  }

  /**
   * Pointer position in the editor's own (document-local) coordinate space.
   * Node positions, port hit boxes and the rubber line all live in this space,
   * so scene-space input must be mapped through the editor's transform before
   * it is compared with them — raw `sceneX/sceneY` is only correct at identity.
   */
  private getLocalPoint(event: VectoJSEvent): { x: number; y: number } | null {
    if (event.sceneX === undefined || event.sceneY === undefined) return null;
    return this.worldToLocal(event.sceneX, event.sceneY);
  }
  private findPortAt(point: { x: number; y: number }): { nodeId: string; portId: string } | null {
    for (const node of this.documentState.nodes) {
      for (const [index, port] of (node.ports ?? []).entries()) {
        const x =
          node.position.x +
          (port.direction === 'output'
            ? (node.width ?? NODE_WIDTH) - PORT_SIZE / 2
            : -PORT_SIZE / 2);
        const y = node.position.y + 24 + index * 20;
        if (point.x >= x && point.x <= x + PORT_SIZE && point.y >= y && point.y <= y + PORT_SIZE)
          return { nodeId: node.id, portId: port.id };
      }
    }
    return null;
  }
  private applyDocument(document: NodeDocument): void {
    this.documentState = cloneDocument(document);
    this.rebuild();
    this.scene?.markDirty();
  }
  private syncPositions(): void {
    for (const node of this.documentState.nodes) {
      const entity = this.nodeEntities.get(node.id);
      if (entity) entity.setPosition(node.position.x, node.position.y);
    }
  }
  private rebuild(): void {
    for (const child of [...this.children]) this.remove(child);
    this.nodeEntities.clear();
    this.linkEntities.clear();
    for (const node of this.documentState.nodes)
      this.nodeEntities.set(node.id, new NodeCard(node, this));
    for (const link of this.documentState.links) {
      const entity = new LinkEntity(link, this.nodeEntities);
      this.linkEntities.set(link.id, entity);
      this.add(entity);
    }
    for (const entity of this.nodeEntities.values()) this.add(entity);
  }
}

function validateConnection(document: NodeDocument, link: LinkData): boolean {
  try {
    addLink(document, link);
    return true;
  } catch {
    return false;
  }
}

function createSafeDocument(document?: NodeDocument): NodeDocument {
  return cloneDocument(document ?? { nodes: [], links: [] });
}
