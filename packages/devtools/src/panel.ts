import { Scene, Entity, type IRenderer } from '@vectojs/core';
import {
  TreeView,
  Text,
  Button,
  Card,
  Tabs,
  type TabItem,
  Input,
  Toggle,
  Dropdown,
  Tooltip,
} from '@vectojs/ui';
import { buildTreeModel, describeEntity, pickInScene, type DevtoolsTreeNode } from './model';
import { auditScene, type AuditFinding } from './audit';
import { entityPath, inspectEntity } from './inspect';
import { createEventTrace, type EventTrace } from './eventTrace';

export type DockSide = 'right' | 'left';

export interface DevtoolsOptions {
  /** Panel width in px. Default 360. */
  width?: number;
  /** Auto-refresh interval in ms while open; 0 disables. Default 500. */
  refreshInterval?: number;
  /** Observe and render recent pointer, wheel, and keyboard routing. Default false. */
  traceEvents?: boolean;
  /** Maximum retained trace records when `traceEvents` is enabled. Default 50. */
  traceCapacity?: number;
  /** Which edge to dock to. Default `'right'`. */
  dockSide?: DockSide;
  /** Show the live performance HUD strip (FPS / counts). Default true. */
  showPerf?: boolean;
  /** Tab selected on mount: `'tree' | 'inspect' | 'audit' | 'events' | 'settings'`. Default `'tree'`. */
  defaultTab?: string;
}

// --- Design tokens (modernized dark glass skin) --------------------------
const PANEL_BG = 'rgba(13, 17, 28, 0.82)';
const CARD_BG = 'rgba(23, 30, 46, 0.72)';
const CARD_BORDER = 'rgba(80, 100, 140, 0.28)';
const PANEL_FG = '#cbd5e1';
const MUTED = '#7c8aa5';
const ACCENT = '#38bdf8';
const WARN = '#fbbf24';
const GOOD = '#4ade80';
const GHOST_BG = 'rgba(56, 189, 248, 0.12)';
const GHOST_HOVER = 'rgba(56, 189, 248, 0.24)';
const RADIUS = 12;

/** A small rounded count/label pill (local; @vectojs/ui has no Badge yet). */
class Pill extends Entity {
  constructor(
    private label: string,
    private fg: string = PANEL_FG,
    private bg: string = 'rgba(120,140,170,0.18)',
  ) {
    super();
    this.width = 54;
    this.height = 20;
  }

  public setLabel(label: string): void {
    this.label = label;
  }

  public isPointInside(_x?: number, _y?: number): boolean {
    return false;
  }

  public getContentProjection() {
    return null;
  }

  public render(r: IRenderer): void {
    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, 10);
    r.fill(this.bg);
    r.fillText(this.label, 8, 14, '11px sans-serif', this.fg);
  }
}

/**
 * The in-page Virtual Math Tree inspector. One instance per inspected Scene;
 * the panel itself is a VectoJS Scene (dogfooding) rendered into its own
 * canvas, docked to an edge of the page.
 */
export class DevtoolsPanel {
  private host: Scene;
  private container: HTMLDivElement;
  private panelScene: Scene;
  private tabs: Tabs;
  private tree: TreeView;
  private auditTree: TreeView;
  private detailLines: Text[] = [];
  private traceLines: Text[] = [];
  private perfLines: Text[] = [];
  private eventTrace: EventTrace | null = null;
  private index: Map<string, Entity> = new Map();
  private allNodes: DevtoolsTreeNode[] = [];
  private filterText = '';
  private selected: Entity | null = null;
  private highlight: HighlightEntity | null = null;
  private highlightEnabled = true;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private perfTimer: ReturnType<typeof setInterval> | null = null;
  private pickArmed = false;
  private width: number;
  private dockSide: DockSide;
  private destroyed = false;
  private findings: AuditFinding[] = [];
  private countPill: Pill;
  private interactivePill: Pill;
  private warnPill: Pill;
  private editX: Input | null = null;
  private editY: Input | null = null;
  private editOpacity: Input | null = null;
  private syncingEdit = false;
  // Reflow state: pieces whose geometry depends on the live viewport height.
  private showPerf = true;
  private perfCard: Card | null = null;
  private treeInner: TreeView | null = null;
  private auditInner: TreeView | null = null;
  private readonly tabsTop = 96;
  private readonly perfH = 78;
  private onWindowResize = () => this.layout();

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
    this.width = options.width ?? 360;
    this.dockSide = options.dockSide ?? 'right';
    const height = typeof window !== 'undefined' ? window.innerHeight : 600;
    this.showPerf = options.showPerf ?? true;
    const showPerf = this.showPerf;

    this.container = document.createElement('div');
    this.container.setAttribute('data-vecto-devtools', '');
    const cs = this.container.style;
    cs.position = 'fixed';
    cs.top = '0';
    cs.height = '100%';
    cs.width = `${this.width}px`;
    cs.zIndex = '99999';
    // Modern glass skin: translucent fill, blur, soft shadow, rounded inner corners.
    cs.background = PANEL_BG;
    (cs as unknown as { backdropFilter: string }).backdropFilter = 'blur(10px)';
    (cs as unknown as { webkitBackdropFilter: string }).webkitBackdropFilter = 'blur(10px)';
    this.applyDockSideStyle();
    // The dock container and canvas MUST stay `pointer-events: none` so clicks
    // over painted-but-non-interactive panel chrome fall through to the host
    // page; the panel's own controls opt back in via their a11y shadow nodes'
    // `pointer-events: auto` (mirrors Scene.a11yRoot). See panel.test.ts.
    cs.pointerEvents = 'none';

    const canvas = document.createElement('canvas');
    canvas.width = this.width;
    canvas.height = height;
    canvas.style.pointerEvents = 'none';
    this.container.appendChild(canvas);
    document.body.appendChild(this.container);

    // The inspector must not inspect itself into a loop: no content
    // projection, onDemand rendering.
    this.panelScene = new Scene(canvas, {
      disableWindowResize: true,
      contentProjection: false,
    });
    this.panelScene.renderMode = 'onDemand';

    // --- Header: title + icon toolbar + count badges ---------------------
    const headerCard = new Card({
      width: this.width - 16,
      height: 78,
      bg: CARD_BG,
      border: CARD_BORDER,
      radius: RADIUS,
    });
    headerCard.setPosition(8, 8);
    this.panelScene.add(headerCard);

    const title = new Text('VectoJS DevTools', {
      font: 'bold 13px sans-serif',
      color: '#e8eefc',
    });
    title.setPosition(18, 26);
    this.panelScene.add(title);

    // Text-glyph icon buttons (ghost style) with tooltips.
    const iconBtn = (glyph: string, x: number, tip: string, onClick: () => void): Button => {
      const b = new Button(glyph, {
        width: 34,
        height: 28,
        radius: 8,
        bg: GHOST_BG,
        hoverBg: GHOST_HOVER,
        color: ACCENT,
        font: '15px sans-serif',
        onClick,
      });
      b.setPosition(x, 40);
      this.panelScene.add(b);
      this.panelScene.add(new Tooltip({ target: b, content: tip }));
      return b;
    };
    iconBtn('⌖', 18, 'Pick an entity on the page', () => this.armPick());
    iconBtn('⟳', 58, 'Refresh the tree', () => this.refresh());
    iconBtn('⚠', 98, 'Run a layout audit', () => this.audit());

    // Count badges, right-aligned in the header.
    this.countPill = new Pill('0', PANEL_FG);
    this.interactivePill = new Pill('0 ⚡', ACCENT, 'rgba(56,189,248,0.14)');
    this.warnPill = new Pill('0 ⚠', WARN, 'rgba(251,191,36,0.14)');
    const pillY = 44;
    this.warnPill.setPosition(this.width - 8 - 48, pillY);
    this.interactivePill.setPosition(this.width - 8 - 48 - 54, pillY);
    this.countPill.setPosition(this.width - 8 - 48 - 54 - 50, pillY);
    this.countPill.width = 44;
    this.interactivePill.width = 48;
    this.warnPill.width = 44;
    this.panelScene.add(this.countPill);
    this.panelScene.add(this.interactivePill);
    this.panelScene.add(this.warnPill);

    // --- Tabs region -----------------------------------------------------
    // Height-dependent geometry (tabs height, tree heights, perf card Y) is
    // finalized in layout(), which also runs on every window resize so the
    // bottom-anchored perf strip never falls below the fold.
    const perfH = showPerf ? this.perfH : 0;
    const tabsHeight = Math.max(200, height - this.tabsTop - perfH - 12);
    const contentW = this.width - 16;
    const barH = 30;
    const bodyH = tabsHeight - barH;

    // Tree tab: search + tree.
    const treeContent = new Container();
    const search = new Input({
      width: contentW - 16,
      height: 30,
      placeholder: 'Filter by type or id…',
      font: '13px sans-serif',
      color: '#e8eefc',
      radius: 8,
      bg: 'rgba(15,23,42,0.92)',
      onChange: (v) => this.setFilter(v),
    });
    search.setPosition(8, 8);
    treeContent.add(search);
    this.tree = new TreeView({
      nodes: [],
      width: contentW - 16,
      height: bodyH - 48,
      rowHeight: 20,
      font: '12px monospace',
      color: PANEL_FG,
      selectedColor: ACCENT,
      onSelect: (node) => {
        const entity = this.index.get(node.id);
        if (entity) this.select(entity);
      },
    });
    this.tree.setPosition(8, 46);
    this.treeInner = this.tree;
    treeContent.add(this.tree);

    // Inspect tab: readout lines + inline editors + copy actions.
    const inspectContent = new Container();
    for (let i = 0; i < 8; i++) {
      const line = new Text('', { font: '12px monospace', color: i === 0 ? '#e8eefc' : PANEL_FG });
      line.setPosition(10, 18 + i * 17);
      this.detailLines.push(line);
      inspectContent.add(line);
    }
    // Labeled inline editors. Each field is `label + Input`, laid out in a
    // three-column row with generous, readable inputs (13px, high contrast).
    const editTop = 18 + 8 * 17 + 10;
    const fieldW = Math.floor((contentW - 16 - 2 * 8) / 3);
    const editorInput = (placeholder: string, x: number, prop: 'x' | 'y' | 'opacity'): Input => {
      inspectContent.add(
        new Text(placeholder, { font: '10px sans-serif', color: MUTED }).setPosition(x, editTop),
      );
      const input = new Input({
        width: fieldW,
        height: 30,
        placeholder,
        font: '13px monospace',
        color: '#e8eefc',
        bg: 'rgba(15,23,42,0.92)',
        radius: 8,
        onChange: (v) => this.applyEdit(prop, v),
      });
      input.setPosition(x, editTop + 14);
      inspectContent.add(input);
      return input;
    };
    this.editX = editorInput('x', 10, 'x');
    this.editY = editorInput('y', 10 + fieldW + 8, 'y');
    this.editOpacity = editorInput('opacity', 10 + 2 * (fieldW + 8), 'opacity');

    const copyRowY = editTop + 14 + 30 + 12;
    const copyW = Math.floor((contentW - 16 - 8) / 2);
    const copyPath = new Button('Copy path', {
      width: copyW,
      height: 30,
      radius: 8,
      bg: GHOST_BG,
      hoverBg: GHOST_HOVER,
      color: ACCENT,
      font: '12px sans-serif',
      onClick: () => this.copySelection('path'),
    });
    copyPath.setPosition(10, copyRowY);
    const copyJson = new Button('Copy JSON', {
      width: copyW,
      height: 30,
      radius: 8,
      bg: GHOST_BG,
      hoverBg: GHOST_HOVER,
      color: ACCENT,
      font: '12px sans-serif',
      onClick: () => this.copySelection('json'),
    });
    copyJson.setPosition(10 + copyW + 8, copyRowY);
    inspectContent.add(copyPath);
    inspectContent.add(copyJson);

    // Audit tab: findings list.
    const auditContent = new Container();
    this.auditTree = new TreeView({
      nodes: [],
      width: contentW - 16,
      height: bodyH - 16,
      rowHeight: 22,
      font: '11px monospace',
      color: PANEL_FG,
      selectedColor: WARN,
      onSelect: (node) => {
        const m = /^finding:(\d+)$/.exec(node.id);
        if (m) this.selectFinding(Number(m[1]));
      },
    });
    this.auditTree.setPosition(8, 8);
    this.auditInner = this.auditTree;
    auditContent.add(this.auditTree);

    const tabItems: TabItem[] = [
      { id: 'tree', label: 'Tree', content: treeContent },
      { id: 'inspect', label: 'Info', content: inspectContent },
      { id: 'audit', label: 'Audit', content: auditContent },
    ];

    // Events tab (opt-in).
    if (options.traceEvents) {
      this.eventTrace = createEventTrace(this.host, { capacity: options.traceCapacity });
      const eventsContent = new Container();
      for (let i = 0; i < 8; i++) {
        const line = new Text('', { font: '11px monospace', color: PANEL_FG });
        line.setPosition(10, 16 + i * 16);
        this.traceLines.push(line);
        eventsContent.add(line);
      }
      tabItems.push({ id: 'events', label: 'Log', content: eventsContent });
      this.eventTrace.subscribe(() => {
        this.writeTrace();
        this.panelScene.markDirty();
      });
      this.writeTrace();
    }

    // Settings tab.
    tabItems.push({ id: 'settings', label: '⚙', content: this.buildSettings(contentW, options) });

    this.tabs = new Tabs({
      width: contentW,
      height: tabsHeight,
      tabHeight: barH,
      tabWidth: Math.floor(contentW / tabItems.length),
      value: options.defaultTab ?? 'tree',
      tabs: tabItems,
    });
    this.tabs.setPosition(8, this.tabsTop);
    this.panelScene.add(this.tabs);

    // --- Perf HUD strip --------------------------------------------------
    // Positioned by layout() (below) so it tracks the live viewport bottom.
    if (showPerf) {
      this.perfCard = new Card({
        width: contentW,
        height: perfH,
        bg: CARD_BG,
        border: CARD_BORDER,
        radius: RADIUS,
      });
      this.panelScene.add(this.perfCard);
      for (let i = 0; i < 3; i++) {
        const line = new Text('', { font: '12px monospace', color: i === 0 ? GOOD : MUTED });
        this.perfLines.push(line);
        this.panelScene.add(line);
      }
      this.writePerf();
      this.perfTimer = setInterval(() => this.writePerf(), 250);
    }

    document.addEventListener('click', this.onHostPick, true);
    document.addEventListener('keydown', this.onKeyNudge);
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', this.onWindowResize);
    }

    const interval = options.refreshInterval ?? 500;
    if (interval > 0) {
      this.refreshTimer = setInterval(() => this.refresh(), interval);
    }

    this.layout();
    this.panelScene.start();
    this.refresh();
  }

  /**
   * Reflow every height-dependent piece to the live viewport height. Runs once
   * at construction and on each `window.resize`. Without this the panel canvas
   * would keep the innerHeight it was built with (the scene is created with
   * `disableWindowResize`), so a shorter viewport — later resize, browser
   * chrome, or a zoom change — would push the bottom-anchored perf strip below
   * the fold. Widths are fixed (the dock width never changes), so only the
   * vertical axis is recomputed here.
   */
  private layout(): void {
    if (this.destroyed) return;
    const height = typeof window !== 'undefined' ? window.innerHeight : 600;
    // Match the panel scene's backing store + CSS height to the viewport so
    // painted content maps 1:1 to on-screen pixels.
    if (this.panelScene.height !== height) this.panelScene.resize(this.width, height);

    const perfH = this.showPerf ? this.perfH : 0;
    const tabsHeight = Math.max(200, height - this.tabsTop - perfH - 12);
    const barH = this.tabs.tabHeight;
    const bodyH = tabsHeight - barH;

    // Tabs re-derive their content geometry from `height` every frame.
    this.tabs.height = tabsHeight;
    if (this.treeInner) this.treeInner.height = Math.max(80, bodyH - 48);
    if (this.auditInner) this.auditInner.height = Math.max(80, bodyH - 16);

    if (this.showPerf && this.perfCard) {
      const top = height - perfH - 8;
      this.perfCard.setPosition(8, top);
      for (let i = 0; i < this.perfLines.length; i++) {
        this.perfLines[i].setPosition(18, top + 14 + i * 18);
      }
    }
    this.panelScene.markDirty();
  }

  private applyDockSideStyle(): void {
    const cs = this.container.style;
    if (this.dockSide === 'right') {
      cs.right = '0';
      cs.left = '';
      cs.borderLeft = `1px solid ${CARD_BORDER}`;
      cs.borderRight = '';
      cs.borderRadius = '14px 0 0 14px';
      cs.boxShadow = '-16px 0 40px rgba(0,0,0,0.35)';
    } else {
      cs.left = '0';
      cs.right = '';
      cs.borderRight = `1px solid ${CARD_BORDER}`;
      cs.borderLeft = '';
      cs.borderRadius = '0 14px 14px 0';
      cs.boxShadow = '16px 0 40px rgba(0,0,0,0.35)';
    }
  }

  private buildSettings(contentW: number, options: DevtoolsOptions): Entity {
    const c = new Container();
    let y = 14;
    const rowGap = 46;
    const ddW = 104;

    const highlightToggle = new Toggle({
      label: 'Selection highlight',
      checked: true,
      font: '13px sans-serif',
      color: PANEL_FG,
      accent: ACCENT,
      onChange: (v) => this.setHighlightEnabled(v),
    });
    highlightToggle.setPosition(10, y);
    c.add(highlightToggle);
    y += rowGap;

    c.add(
      new Text('Refresh (ms)', { font: '13px sans-serif', color: PANEL_FG }).setPosition(10, y + 8),
    );
    const refreshDd = new Dropdown(['0', '250', '500', '1000'], {
      value: String(options.refreshInterval ?? 500),
      width: ddW,
      height: 30,
      font: '13px sans-serif',
      onChange: (v: string) => this.setRefreshInterval(Number(v)),
    });
    refreshDd.setPosition(contentW - ddW - 12, y);
    c.add(refreshDd);
    y += rowGap;

    c.add(
      new Text('Dock side', { font: '13px sans-serif', color: PANEL_FG }).setPosition(10, y + 8),
    );
    const sideDd = new Dropdown(['right', 'left'], {
      value: this.dockSide,
      width: ddW,
      height: 30,
      font: '13px sans-serif',
      onChange: (v: string) => this.setDockSide(v as DockSide),
    });
    sideDd.setPosition(contentW - ddW - 12, y);
    c.add(sideDd);

    return c;
  }

  /** Rebuild the tree model from the host scene. */
  public refresh(): void {
    if (this.destroyed) return;
    const { nodes, index } = buildTreeModel(this.host.rootEntity);
    const overlay = buildTreeModel(this.host.overlayRootEntity);
    for (const [id, entity] of overlay.index) index.set(id, entity);
    this.index = index;
    this.allNodes = [...nodes, ...overlay.nodes];
    this.applyFilterToTree();
    this.writeCounts();
    if (this.selected) this.writeDetails(this.selected);
    this.panelScene.markDirty();
  }

  /** Set the tree filter substring (case-insensitive). */
  public setFilter(text: string): void {
    this.filterText = text.trim().toLowerCase();
    this.applyFilterToTree();
    this.panelScene.markDirty();
  }

  private applyFilterToTree(): void {
    if (!this.filterText) {
      this.tree.setNodes(this.allNodes);
      return;
    }
    const q = this.filterText;
    const prune = (node: DevtoolsTreeNode): DevtoolsTreeNode | null => {
      const kids = (node.children ?? [])
        .map(prune)
        .filter((n): n is DevtoolsTreeNode => n !== null);
      const selfMatch = node.label.toLowerCase().includes(q) || node.id.toLowerCase().includes(q);
      if (selfMatch || kids.length > 0) {
        return { ...node, children: kids.length > 0 ? kids : node.children };
      }
      return null;
    };
    this.tree.setNodes(this.allNodes.map(prune).filter((n): n is DevtoolsTreeNode => n !== null));
  }

  private writeCounts(): void {
    let total = 0;
    let interactive = 0;
    for (const entity of this.index.values()) {
      total++;
      if (entity.interactive) interactive++;
    }
    this.countPill.setLabel(`${total}`);
    this.interactivePill.setLabel(`${interactive} ⚡`);
    this.warnPill.setLabel(`${this.findings.length} ⚠`);
  }

  private writePerf(): void {
    if (this.destroyed || this.perfLines.length === 0) return;
    const s = this.host.frameStats;
    this.perfLines[0]?.setText(`${s.fps.toFixed(0)} fps   ${s.frameTimeMs.toFixed(1)} ms/frame`);
    this.perfLines[1]?.setText(
      `${this.index.size} entities   ${s.renderMode}${s.dirty ? ' • dirty' : ''}`,
    );
    this.perfLines[2]?.setText(`rendered ${s.renderedFrames}   skipped ${s.skippedFrames}`);
    this.panelScene.markDirty();
  }

  /** Arm one-shot pick mode: the next click on the page selects the entity under it. */
  public armPick(): void {
    this.pickArmed = true;
  }

  /**
   * Run the layout audit on the host scene and list the findings in the Audit
   * tab. Selecting a finding selects and highlights the offending entity.
   * Returns the findings so agents and tests can drive the panel programmatically.
   */
  public audit(): AuditFinding[] {
    if (this.destroyed) return [];
    // Rebuild the index first so finding ids resolve to live entities.
    const { index } = buildTreeModel(this.host.rootEntity);
    const overlay = buildTreeModel(this.host.overlayRootEntity);
    for (const [id, entity] of overlay.index) index.set(id, entity);
    this.index = index;

    this.findings = auditScene(this.host);
    this.auditTree.setNodes(
      this.findings.map((f, i) => ({
        id: `finding:${i}`,
        label: `⚠ ${f.kind}: ${f.message}`,
      })),
    );
    this.detailLines[0]?.setText(
      this.findings.length === 0 ? 'audit clean' : `${this.findings.length} finding(s)`,
    );
    this.writeCounts();
    this.showTab('audit');
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
    if (this.highlightEnabled) {
      if (!this.highlight) {
        this.highlight = new HighlightEntity();
        this.host.showOverlay(this.highlight);
      }
      this.highlight.track(entity);
      this.host.markDirty();
    }
    this.writeDetails(entity);
    this.syncInspector(entity);
    this.showTab('inspect');
    this.panelScene.markDirty();
  }

  private showTab(id: string): void {
    if (this.tabs && this.tabs.value !== id) this.tabs.emit('change', { value: id });
  }

  /** The currently selected entity, if any. */
  public get selection(): Entity | null {
    return this.selected;
  }

  /** Optional generic routing trace, enabled with `traceEvents`. */
  public get trace(): EventTrace | null {
    return this.eventTrace;
  }

  /** Toggle the host-side selection highlight box. */
  public setHighlightEnabled(enabled: boolean): void {
    this.highlightEnabled = enabled;
    if (!enabled && this.highlight) {
      this.host.hideOverlay(this.highlight);
      this.highlight.destroy();
      this.highlight = null;
      this.host.markDirty();
    } else if (enabled && this.selected) {
      this.select(this.selected);
    }
  }

  /** Change the auto-refresh cadence (ms; 0 disables). */
  public setRefreshInterval(ms: number): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (ms > 0) this.refreshTimer = setInterval(() => this.refresh(), ms);
  }

  /** Move the dock to the given edge. */
  public setDockSide(side: DockSide): void {
    this.dockSide = side;
    this.applyDockSideStyle();
  }

  private applyEdit(prop: 'x' | 'y' | 'opacity', raw: string): void {
    if (this.syncingEdit || !this.selected) return;
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    if (prop === 'opacity') this.selected.opacity = Math.max(0, Math.min(1, n));
    else this.selected[prop] = n;
    this.host.markDirty();
    this.writeDetails(this.selected);
    if (this.highlightEnabled && this.highlight) {
      this.highlight.track(this.selected);
      this.host.markDirty();
    }
    this.panelScene.markDirty();
  }

  private syncInspector(entity: Entity): void {
    this.syncingEdit = true;
    const r = (n: number) => String(Math.round(n * 100) / 100);
    if (this.editX) this.editX.value = r(entity.x);
    if (this.editY) this.editY.value = r(entity.y);
    if (this.editOpacity) this.editOpacity.value = r(entity.opacity);
    this.syncingEdit = false;
  }

  private copySelection(kind: 'path' | 'json'): void {
    if (!this.selected) return;
    const payload =
      kind === 'path'
        ? entityPath(this.selected)
        : JSON.stringify(inspectEntity(this.selected), null, 2);
    const clip = (
      globalThis as { navigator?: { clipboard?: { writeText?: (t: string) => unknown } } }
    ).navigator?.clipboard;
    clip?.writeText?.(payload);
  }

  private writeDetails(entity: Entity): void {
    const lines = describeEntity(entity);
    for (let i = 0; i < this.detailLines.length; i++) {
      this.detailLines[i].setText(lines[i] ?? '');
    }
  }

  private writeTrace(): void {
    if (!this.eventTrace || this.traceLines.length === 0) return;
    const recent = this.eventTrace.entries.slice(-(this.traceLines.length - 1)).reverse();
    this.traceLines[0]?.setText(`trace ${this.eventTrace.entries.length} event(s)`);
    for (let i = 1; i < this.traceLines.length; i++) {
      const entry = recent[i - 1];
      this.traceLines[i].setText(
        entry
          ? `${entry.type} ${entry.source} ${entry.targetId?.slice(0, 8) ?? entry.key ?? ''}`
          : '',
      );
    }
  }

  /** Tear down the panel, host highlight, listeners, and timers. */
  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.perfTimer) clearInterval(this.perfTimer);
    this.eventTrace?.destroy();
    document.removeEventListener('click', this.onHostPick, true);
    document.removeEventListener('keydown', this.onKeyNudge);
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', this.onWindowResize);
    }
    if (this.highlight) {
      this.host.hideOverlay(this.highlight);
      this.highlight.destroy();
      this.highlight = null;
    }
    this.panelScene.destroy();
    this.container.remove();
  }
}

/** A bare layout container: no paint, no projection, holds tab children. */
class Container extends Entity {
  public isPointInside(_x?: number, _y?: number): boolean {
    return false;
  }
  public getContentProjection() {
    return null;
  }
  public render(): void {}
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

  public isPointInside(_x?: number, _y?: number): boolean {
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
    fill(color: string): void;
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
    r.roundRect(minX - 1, minY - 1, maxX - minX + 2, maxY - minY + 2, 3);
    r.fill('rgba(56, 189, 248, 0.10)');
    r.beginPath();
    r.roundRect(minX - 1, minY - 1, maxX - minX + 2, maxY - minY + 2, 3);
    r.stroke(ACCENT, 2);
  }
}
