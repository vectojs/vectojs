import { Entity, type IRenderer, type VectoJSEvent } from '@vectojs/core';
import { UIComponent } from '@vectojs/ui';
import { CommandHistory } from './history';
import {
  cloneDocument,
  getNode,
  updateNodePosition,
  type LinkData,
  type NodeData,
  type NodeDocument,
} from './model';
import { SelectionState } from './selection';

const NODE_WIDTH = 180;
const NODE_HEIGHT = 76;

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
  public render(): void {}

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

  public beginDrag(id: string, event: VectoJSEvent): void {
    const node = getNode(this.documentState, id);
    if (!node || event.sceneX === undefined || event.sceneY === undefined) return;
    this.select(id, event.shiftKey || event.metaKey || event.ctrlKey);
    this.dragDocument = cloneDocument(this.documentState);
    this.selection.drag = {
      nodeId: id,
      originX: node.position.x,
      originY: node.position.y,
      pointerX: event.sceneX,
      pointerY: event.sceneY,
    };
  }

  public moveDrag(event: VectoJSEvent): void {
    const drag = this.selection.drag;
    if (!drag || event.sceneX === undefined || event.sceneY === undefined) return;
    const position = {
      x: drag.originX + event.sceneX - drag.pointerX,
      y: drag.originY + event.sceneY - drag.pointerY,
    };
    this.applyPreview(updateNodePosition(this.documentState, drag.nodeId, position));
  }

  public endDrag(event: VectoJSEvent): void {
    if (!this.selection.drag) return;
    if (event.sceneX !== undefined && event.sceneY !== undefined) this.moveDrag(event);
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
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key?.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) this.redo();
      else this.undo();
    } else if (modifier && event.key?.toLowerCase() === 'y') {
      event.preventDefault();
      this.redo();
    }
  }

  private applyPreview(document: NodeDocument): void {
    this.documentState = cloneDocument(document);
    this.syncPositions();
    this.scene?.markDirty();
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

function createSafeDocument(document?: NodeDocument): NodeDocument {
  return cloneDocument(document ?? { nodes: [], links: [] });
}
