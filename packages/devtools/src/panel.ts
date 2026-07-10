import { Scene, Entity } from '@vectojs/core';
import { TreeView, Text, Button } from '@vectojs/ui';
import { buildTreeModel, describeEntity, pickInScene } from './model';
import { auditScene, type AuditFinding } from './audit';

export interface DevtoolsOptions {
  /** Panel width in px. Default 320. */
  width?: number;
  /** Auto-refresh interval in ms while open; 0 disables. Default 500. */
  refreshInterval?: number;
}

const PANEL_BG = 'rgba(10, 14, 24, 0.96)';
const PANEL_FG = '#cbd5e1';
const ACCENT = '#38bdf8';

/**
 * The in-page Virtual Math Tree inspector. One instance per inspected Scene;
 * the panel itself is a VectoJS Scene (dogfooding) rendered into its own
 * canvas, docked to the right edge of the page.
 */
export class DevtoolsPanel {
  private host: Scene;
  private container: HTMLDivElement;
  private panelScene: Scene;
  private tree: TreeView;
  private detailLines: Text[] = [];
  private index: Map<string, Entity> = new Map();
  private selected: Entity | null = null;
  private highlight: HighlightEntity | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private pickArmed = false;
  private width: number;
  private destroyed = false;
  private findings: AuditFinding[] = [];

  private onHostPick = (ev: MouseEvent) => {
    if (!this.pickArmed) return;
    this.pickArmed = false;
    const point = this.host.clientToScene(ev.clientX, ev.clientY);
    const hit = pickInScene(this.host, point.x, point.y);
    if (hit) this.select(hit);
    ev.stopPropagation();
    ev.preventDefault();
  };

  private onKeyNudge = (ev: KeyboardEvent) => {
    if (!this.selected) return;
    const target = ev.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    const step = ev.shiftKey ? 10 : 1;
    let handled = true;
    switch (ev.key) {
      case 'ArrowLeft':
        this.selected.x -= step;
        break;
      case 'ArrowRight':
        this.selected.x += step;
        break;
      case 'ArrowUp':
        this.selected.y -= step;
        break;
      case 'ArrowDown':
        this.selected.y += step;
        break;
      case '+':
        this.selected.opacity = Math.min(1, this.selected.opacity + 0.1);
        break;
      case '-':
        this.selected.opacity = Math.max(0, this.selected.opacity - 0.1);
        break;
      default:
        handled = false;
    }
    if (handled) {
      ev.preventDefault();
      this.host.markDirty();
      this.select(this.selected); // refresh readout + highlight box
    }
  };

  constructor(host: Scene, options: DevtoolsOptions = {}) {
    this.host = host;
    this.width = options.width ?? 320;
    const height = typeof window !== 'undefined' ? window.innerHeight : 600;

    this.container = document.createElement('div');
    this.container.setAttribute('data-vecto-devtools', '');
    const cs = this.container.style;
    cs.position = 'fixed';
    cs.top = '0';
    cs.right = '0';
    cs.width = `${this.width}px`;
    cs.height = '100%';
    cs.zIndex = '99999';
    cs.background = PANEL_BG;
    cs.borderLeft = `1px solid ${ACCENT}`;

    const canvas = document.createElement('canvas');
    canvas.width = this.width;
    canvas.height = height;
    this.container.appendChild(canvas);
    document.body.appendChild(this.container);

    // The inspector must not inspect itself into a loop: no content
    // projection, onDemand rendering.
    this.panelScene = new Scene(canvas, {
      disableWindowResize: true,
      contentProjection: false,
    });
    this.panelScene.renderMode = 'onDemand';

    const title = new Text('VectoJS DevTools', { font: 'bold 14px monospace' });
    title.setPosition(12, 10);
    this.panelScene.add(title);

    const pickBtn = new Button('Pick', { width: 64, height: 24 });
    pickBtn.setPosition(12, 34);
    pickBtn.on('click', () => this.armPick());
    this.panelScene.add(pickBtn);

    const refreshBtn = new Button('Refresh', { width: 84, height: 24 });
    refreshBtn.setPosition(84, 34);
    refreshBtn.on('click', () => this.refresh());
    this.panelScene.add(refreshBtn);

    const auditBtn = new Button('Audit', { width: 64, height: 24 });
    auditBtn.setPosition(176, 34);
    auditBtn.on('click', () => this.audit());
    this.panelScene.add(auditBtn);

    const treeHeight = Math.max(160, Math.floor(height * 0.55));
    this.tree = new TreeView({
      nodes: [],
      width: this.width - 16,
      height: treeHeight,
      rowHeight: 20,
      font: '12px monospace',
      color: PANEL_FG,
      selectedColor: ACCENT,
      onSelect: (node) => {
        const findingMatch = /^finding:(\d+)$/.exec(node.id);
        if (findingMatch) {
          this.selectFinding(Number(findingMatch[1]));
          return;
        }
        const entity = this.index.get(node.id);
        if (entity) this.select(entity);
      },
    });
    this.tree.setPosition(8, 68);
    this.panelScene.add(this.tree);

    // Detail readout: fixed pool of monospace lines under the tree.
    const detailTop = 68 + treeHeight + 12;
    for (let i = 0; i < 8; i++) {
      const line = new Text('', { font: '11px monospace' });
      line.setPosition(12, detailTop + i * 16);
      this.detailLines.push(line);
      this.panelScene.add(line);
    }

    document.addEventListener('click', this.onHostPick, true);
    document.addEventListener('keydown', this.onKeyNudge);

    const interval = options.refreshInterval ?? 500;
    if (interval > 0) {
      this.refreshTimer = setInterval(() => this.refresh(), interval);
    }

    this.panelScene.start();
    this.refresh();
  }

  /** Rebuild the tree model from the host scene. */
  public refresh(): void {
    if (this.destroyed) return;
    const { nodes, index } = buildTreeModel(this.host.rootEntity);
    const overlay = buildTreeModel(this.host.overlayRootEntity);
    for (const [id, entity] of overlay.index) index.set(id, entity);
    this.index = index;
    this.tree.setNodes([...nodes, ...overlay.nodes]);
    if (this.selected) this.writeDetails(this.selected);
    this.panelScene.markDirty();
  }

  /** Arm one-shot pick mode: the next click on the page selects the entity under it. */
  public armPick(): void {
    this.pickArmed = true;
  }

  /**
   * Run the layout audit on the host scene and list the findings in place of
   * the entity tree (hit Refresh to restore it). Selecting a finding selects
   * and highlights the offending entity. Returns the findings so agents and
   * tests can drive the panel programmatically.
   */
  public audit(): AuditFinding[] {
    if (this.destroyed) return [];
    // Rebuild the index first so finding ids resolve to live entities.
    const { index } = buildTreeModel(this.host.rootEntity);
    const overlay = buildTreeModel(this.host.overlayRootEntity);
    for (const [id, entity] of overlay.index) index.set(id, entity);
    this.index = index;

    this.findings = auditScene(this.host);
    this.tree.setNodes(
      this.findings.map((f, i) => ({
        id: `finding:${i}`,
        label: `⚠ ${f.kind}: ${f.message}`,
      })),
    );
    this.detailLines[0]?.setText(
      this.findings.length === 0 ? 'audit clean' : `${this.findings.length} finding(s)`,
    );
    this.panelScene.markDirty();
    return this.findings;
  }

  /** Select and highlight the entity behind finding `i` from the last {@link audit} run. */
  public selectFinding(i: number): void {
    const finding = this.findings[i];
    const entity = finding ? this.index.get(finding.entityId) : undefined;
    if (entity) this.select(entity);
  }

  /** Select an entity: highlight it on the host scene and show its state. */
  public select(entity: Entity): void {
    this.selected = entity;
    if (!this.highlight) {
      this.highlight = new HighlightEntity();
      this.host.showOverlay(this.highlight);
    }
    this.highlight.track(entity);
    this.host.markDirty();
    this.writeDetails(entity);
    this.panelScene.markDirty();
  }

  /** The currently selected entity, if any. */
  public get selection(): Entity | null {
    return this.selected;
  }

  private writeDetails(entity: Entity): void {
    const lines = describeEntity(entity);
    for (let i = 0; i < this.detailLines.length; i++) {
      this.detailLines[i].setText(lines[i] ?? '');
    }
  }

  /** Tear down the panel, host highlight, listeners, and timers. */
  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    document.removeEventListener('click', this.onHostPick, true);
    document.removeEventListener('keydown', this.onKeyNudge);
    if (this.highlight) {
      this.host.hideOverlay(this.highlight);
      this.highlight.destroy();
      this.highlight = null;
    }
    this.panelScene.destroy();
    this.container.remove();
  }
}

/**
 * Selection outline drawn on the HOST scene's overlay layer: the tracked
 * entity's world-space AABB with an accent border.
 */
class HighlightEntity extends Entity {
  private target: Entity | null = null;

  public track(target: Entity): void {
    this.target = target;
  }

  public isPointInside(): boolean {
    return false;
  }

  public override getContentProjection() {
    return null;
  }

  public render(r: {
    save(): void;
    restore(): void;
    beginPath(): void;
    roundRect(x: number, y: number, w: number, h: number, radius: number): void;
    stroke(color: string, width?: number): void;
  }): void {
    const t = this.target;
    if (!t) return;
    const { a, b, c, d, e, f } = t.getWorldTransform();
    const w = t.width || 8;
    const h = t.height || 8;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < 4; i++) {
      const lx = i & 1 ? w : 0;
      const ly = i & 2 ? h : 0;
      const wx = a * lx + c * ly + e;
      const wy = b * lx + d * ly + f;
      if (wx < minX) minX = wx;
      if (wx > maxX) maxX = wx;
      if (wy < minY) minY = wy;
      if (wy > maxY) maxY = wy;
    }
    r.beginPath();
    r.roundRect(minX - 1, minY - 1, maxX - minX + 2, maxY - minY + 2, 2);
    r.stroke(ACCENT, 2);
  }
}
