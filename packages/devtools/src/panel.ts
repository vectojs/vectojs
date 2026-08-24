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
import {
  highlightGeometry,
  type HighlightLayer,
  type HighlightLayerKind,
} from './highlightGeometry';
import {
  pluginInspectors,
  runPluginAudits,
  runPluginCommand,
  runPluginInspector,
  type PluginFinding,
  type PluginInspector,
  type PluginRow,
} from './plugin';
import { auditA11y, inspectA11y, type A11yFinding } from './a11yInspect';
import { entityPath, inspectEntity, layoutControlledProperties } from './inspect';
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
/**
 * Readout rows in the Inspect tab.
 *
 * Six carry generic Entity properties; the rest carry the selected entity's own
 * `getDevtoolsDescriptor()` output, which is capped to a matching budget in
 * `describeEntity` so the two cannot disagree about how much fits.
 */
const INSPECT_ROWS = 20;
/** Readout rows in the A11y tab: one entity readout plus scene audit findings. */
const A11Y_ROWS = 22;
/**
 * How often to rebuild the tree model regardless of the structure version.
 *
 * Bounds how long a missed structure bump can leave the panel stale, without
 * giving back the per-tick saving the version check buys.
 */
const RECONCILE_INTERVAL_MS = 3000;
/** How long the cached full-scene a11y audit may serve findings without a
 *  re-walk. Audit inputs are not all structural (labels, disabled, opacity,
 *  tabIndex, world bounds), so a version-only cache went stale indefinitely;
 *  this bounds that staleness to the same cadence as the forced reconcile. */
const A11Y_AUDIT_TTL_MS = RECONCILE_INTERVAL_MS;
/**
 * Preferred tab width. `Tabs` scrolls the bar horizontally past this rather than
 * shrinking tabs, so the count can grow without the labels becoming slivers.
 */
const PLUGIN_TAB_WIDTH = 64;
/** Floor the preferred width collapses to before the bar starts scrolling. */
const PLUGIN_TAB_MIN_WIDTH = 48;
/** Readout rows per plugin inspector tab. */
const PLUGIN_ROWS = 18;
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
  private a11yLines: Text[] = [];
  /** Host structure version the current tree model was built from. */
  private treeVersion = -1;
  /** Last edited property that the selection's parent will overwrite, if any. */
  private overriddenProp: 'x' | 'y' | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private traceLines: Text[] = [];
  private perfLines: Text[] = [];
  private eventTrace: EventTrace | null = null;
  private index: Map<string, Entity> = new Map();
  private allNodes: DevtoolsTreeNode[] = [];
  private filterText = '';
  private selected: Entity | null = null;
  private highlight: HighlightEntity | null = null;
  private highlightEnabled = true;
  private highlightLayers: HighlightLayerKind[] = ['aabb'];
  private hitSampleStep: number | undefined;
  /** Plugin inspector id → its tab's readout rows. */
  private pluginTabs = new Map<string, { inspector: PluginInspector; lines: Text[] }>();
  /** Findings from the last audit that came from plugins, kept for `pluginFindings()`. */
  private pluginFindings: PluginFinding[] = [];
  /** Every finding row of the last {@link audit}, scene then plugin, in display
   *  order — the one list both the audit tree and `selectFinding` index. */
  private auditRows: Array<{ kind: string; message: string; entityId?: string }> = [];
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private perfTimer: ReturnType<typeof setInterval> | null = null;
  private pickArmed = false;
  private width: number;
  private dockSide: DockSide;
  private destroyed = false;
  private findings: AuditFinding[] = [];
  /** Host structure version the cached full-scene a11y audit was computed at. */
  private a11yAuditVersion = -1;
  /** Inspected entity the cached audit was computed for (part of the key:
   *  selection changes must not serve another entity's findings). */
  private a11yAuditSelectedId: string | null = null;
  /** Timestamp the cached audit was computed at, for the staleness TTL. */
  private a11yAuditAt = -Infinity;
  private a11yAuditFindings: A11yFinding[] = [];
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
    // The panel container is `pointer-events: none`, but its controls opt back
    // in through their a11y shadow nodes — a click on any control (the pick
    // button itself, search, tree rows) must reach that control instead of
    // being consumed as a host pick. Ignoring the click and keeping pick mode
    // armed is the least surprising: the user was aiming at panel chrome, not
    // at the page, so the pick is still waiting for its host click.
    if (ev.target instanceof Node && this.container.contains(ev.target)) return;
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
    //
    // 20 rows, not 8: `describeEntity` now appends a component's own
    // `getDevtoolsDescriptor()` output after the six generic Entity lines, and
    // that is the part worth reading — a `VirtualList` contributes its visible
    // range, mounted count and measurement state. Rows are cheap (one Text each,
    // created once) and unused ones render as empty strings.
    const inspectContent = new Container();
    for (let i = 0; i < INSPECT_ROWS; i++) {
      const line = new Text('', { font: '12px monospace', color: i === 0 ? '#e8eefc' : PANEL_FG });
      line.setPosition(10, 18 + i * 17);
      this.detailLines.push(line);
      inspectContent.add(line);
    }
    // Labeled inline editors. Each field is `label + Input`, laid out in a
    // three-column row with generous, readable inputs (13px, high contrast).
    const editTop = 18 + INSPECT_ROWS * 17 + 10;
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

    // A11y tab: the selected entity's accessibility readout plus scene-wide audits.
    //
    // Worth its own tab rather than a few lines in Info, because the question it
    // answers is specific to a zero-DOM UI: the canvas can look perfect while the
    // projected accessibility tree is wrong, and no browser DevTools will show
    // that divergence.
    const a11yContent = new Container();
    for (let i = 0; i < A11Y_ROWS; i++) {
      const line = new Text('', {
        font: '11px monospace',
        color: i === 0 ? '#e8eefc' : PANEL_FG,
      });
      line.setPosition(10, 16 + i * 16);
      this.a11yLines.push(line);
      a11yContent.add(line);
    }

    const tabItems: TabItem[] = [
      { id: 'tree', label: 'Tree', content: treeContent },
      { id: 'inspect', label: 'Info', content: inspectContent },
      { id: 'audit', label: 'Audit', content: auditContent },
      { id: 'a11y', label: 'A11y', content: a11yContent },
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

    // One tab per registered plugin inspector, before Settings so the gear stays
    // last. Read at mount; `syncPluginTabs` picks up later registrations.
    for (const inspector of pluginInspectors()) {
      tabItems.push(this.buildPluginTab(inspector));
    }

    // Settings tab.
    tabItems.push({ id: 'settings', label: '⚙', content: this.buildSettings(contentW, options) });

    this.tabs = new Tabs({
      // Deliberately NOT `contentW / tabItems.length`: dividing the bar by the
      // count shrank every tab as tabs were added, so six already sat at ~51px
      // and a plugin or two made the labels unreadable. `Tabs` keeps a preferred
      // width and scrolls the bar horizontally once they overflow, which is the
      // behaviour that survives an unbounded number of plugins.
      width: contentW,
      height: tabsHeight,
      tabHeight: barH,
      tabWidth: PLUGIN_TAB_WIDTH,
      minTabWidth: PLUGIN_TAB_MIN_WIDTH,
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
      // Periodic forced reconcile as a consistency check.
      //
      // The version check makes the common tick cheap, but it trusts that every
      // shape change bumps the counter. Anything that mutates `children` directly,
      // bypassing `add`/`remove`, would leave the panel showing a stale tree with
      // no way for a user to tell. A full rebuild every few seconds bounds how long
      // such a divergence can persist, at a cost of roughly one walk per 3 s
      // instead of six.
      this.reconcileTimer = setInterval(() => this.refresh(true), RECONCILE_INTERVAL_MS);
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
  /**
   * Rebuild the tree model and re-render the panel.
   *
   * @param force - Rebuild even when the tree's shape is unchanged. Used by the
   *   periodic reconcile and by explicit user refreshes.
   */
  public refresh(force = false): void {
    if (this.destroyed) return;

    // Skip the walk when the tree's shape has not changed.
    //
    // This ran unconditionally on a fixed interval, so a large scene paid a
    // constant CPU cost to rebuild a model that was usually identical. The scene
    // already maintains a structure version for its WASM transform store, bumped
    // by `Entity.add`/`remove`, so staleness is an integer comparison.
    //
    // Selection details are still rewritten every tick: an entity's properties
    // change without the tree's shape changing, and a stale readout is the whole
    // reason to look at the panel.
    // Plugins can be registered after this panel mounted, so pick up new ones
    // before the version check: a newly imported plugin has no reason to wait for
    // the next structural change to become visible.
    this.syncPluginTabs();

    const version = this.host.structureVersion;
    if (!force && version === this.treeVersion && this.allNodes.length > 0) {
      if (this.selected) this.writeDetails(this.selected);
      // Plugin readouts follow the same rule as the selection details: component
      // state changes without the tree's shape changing.
      this.writePluginTabs();
      this.writeCounts();
      this.panelScene.markDirty();
      return;
    }
    this.treeVersion = version;

    const { nodes, index } = buildTreeModel(this.host.rootEntity);
    const overlay = buildTreeModel(this.host.overlayRootEntity);
    for (const [id, entity] of overlay.index) index.set(id, entity);
    this.index = index;
    this.allNodes = [...nodes, ...overlay.nodes];
    this.applyFilterToTree();
    this.writeCounts();
    if (this.selected) this.writeDetails(this.selected);
    this.writePluginTabs();
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
    // Plugin audits are appended as ordinary findings, so `selectFinding` and the
    // audit tree need no knowledge of where a finding came from. `runPluginAudits`
    // namespaces the kind with the plugin id, which is what distinguishes them.
    this.pluginFindings = runPluginAudits({
      scene: this.host,
      selection: this.selected ?? null,
    });
    // One list for display and selection: `selectFinding(i)` must resolve the
    // same row the tree shows, including plugin rows. Without this, every
    // plugin row indexed `this.findings` and its click did nothing.
    this.auditRows = [
      ...this.findings.map((f) => ({ kind: f.kind, message: f.message, entityId: f.entityId })),
      ...this.pluginFindings,
    ];
    this.auditTree.setNodes(
      this.auditRows.map((f, i) => ({
        id: `finding:${i}`,
        label: `⚠ ${f.kind}: ${f.message}`,
      })),
    );
    this.detailLines[0]?.setText(
      this.auditRows.length === 0 ? 'audit clean' : `${this.auditRows.length} finding(s)`,
    );
    this.writeCounts();
    this.showTab('audit');
    this.panelScene.markDirty();
    return this.findings;
  }

  /** Select and highlight the entity behind finding `i` from the last {@link audit} run. */
  public selectFinding(i: number): void {
    const finding = this.auditRows[i];
    const entity = finding?.entityId ? this.index.get(finding.entityId) : undefined;
    if (entity) this.select(entity);
  }

  /** Select an entity: highlight it on the host scene and show its state. */
  public select(entity: Entity): void {
    // Cleared here, not in `syncInspector`: that runs AFTER `writeDetails` below,
    // so clearing there rendered the previous entity's override warning once more
    // before dropping it.
    this.overriddenProp = null;
    this.selected = entity;
    if (this.highlightEnabled) {
      if (!this.highlight) {
        this.highlight = new HighlightEntity();
        this.host.showOverlay(this.highlight);
      }
      this.highlight.setLayers(this.highlightLayers, this.hitSampleStep);
      this.highlight.track(entity);
      this.host.markDirty();
    }
    this.writeDetails(entity);
    this.syncInspector(entity);
    this.writePluginTabs();
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

  /**
   * Choose which geometry layers the selection highlight draws.
   *
   * Defaults to `['aabb']`, matching what the panel drew before layers existed.
   * `'hit'` samples `isPointInside` on a grid and is quadratic in the entity's
   * size, so it is never enabled implicitly — pass it explicitly, and raise
   * `hitSampleStep` on a large entity.
   */
  public setHighlightLayers(
    kinds: ReadonlyArray<HighlightLayerKind>,
    hitSampleStep?: number,
  ): void {
    this.highlightLayers = [...kinds];
    this.hitSampleStep = hitSampleStep;
    if (this.highlight) {
      this.highlight.setLayers(this.highlightLayers, hitSampleStep);
      this.host.markDirty();
    }
  }

  /** The layers computed on the most recent highlight draw. */
  public getHighlightLayers(): ReadonlyArray<HighlightLayer> {
    return this.highlight?.layers ?? [];
  }

  /**
   * Build a tab body for one plugin inspector: a fixed row budget, written into
   * on refresh. Rows are pre-allocated for the same reason the built-in tabs
   * pre-allocate — the panel scene is `onDemand`, so churning entities every
   * refresh would dirty it continuously.
   */
  private buildPluginTab(inspector: PluginInspector): TabItem {
    const content = new Container();
    const lines: Text[] = [];
    for (let i = 0; i < PLUGIN_ROWS; i++) {
      const line = new Text('', {
        font: i === 0 ? 'bold 11px monospace' : '11px monospace',
        color: i === 0 ? '#e8eefc' : PANEL_FG,
      });
      line.setPosition(10, 16 + i * 16);
      lines.push(line);
      content.add(line);
    }
    this.pluginTabs.set(inspector.id, { inspector, lines });
    return { id: `plugin:${inspector.id}`, label: inspector.label, content };
  }

  /**
   * Refresh every plugin tab from the current selection.
   *
   * Runs for all plugin tabs rather than only the visible one: the panel does not
   * track which tab is active (that state lives in `Tabs`), and a plugin readout
   * is a handful of string writes, so the saving would not pay for the coupling.
   */
  private writePluginTabs(): void {
    const context = { scene: this.host, selection: this.selected ?? null };
    for (const { inspector, lines } of this.pluginTabs.values()) {
      let rows: PluginRow[];
      if (!this.selected) rows = [{ label: '—', value: 'no selection' }];
      else if (inspector.appliesTo && !appliesToSafely(inspector, this.selected)) {
        rows = [{ label: '—', value: 'does not apply to this entity' }];
      } else {
        rows = runPluginInspector(inspector, context);
        if (rows.length === 0) rows = [{ label: '—', value: 'nothing to report' }];
      }
      lines.forEach((line, i) => {
        const row = rows[i];
        line.setText(
          row ? `${row.label}  ${row.value}${row.note ? `  (${row.note})` : ''}`.trim() : '',
        );
      });
    }
  }

  /**
   * Add tabs for plugins registered after this panel mounted.
   *
   * Called from `refresh()`, so importing a package that registers a plugin makes
   * its tab appear without remounting the panel.
   */
  private syncPluginTabs(): void {
    const known = new Set(this.pluginTabs.keys());
    const added = pluginInspectors().filter((i) => !known.has(i.id));
    if (added.length === 0) return;
    const settingsIdx = this.tabs.tabs.findIndex((t) => t.id === 'settings');
    const items = added.map((i) => this.buildPluginTab(i));
    // Keep Settings last: it is the only tab that is not a readout, and having it
    // move as plugins load would shift a target the user aims at by habit.
    if (settingsIdx >= 0) this.tabs.tabs.splice(settingsIdx, 0, ...items);
    else this.tabs.tabs.push(...items);
    // No explicit `add` of the content: `Tabs.update()` re-derives content
    // geometry and attaches or detaches each body every frame based on the
    // active id, so adding it here would fight that and double-parent it.
    this.panelScene.markDirty();
  }

  /** Findings contributed by plugin audits during the last {@link audit} run. */
  public getPluginFindings(): ReadonlyArray<PluginFinding> {
    return this.pluginFindings;
  }

  /** Rows a plugin inspector currently shows, by inspector id. For tests and agents. */
  public getPluginRows(inspectorId: string): PluginRow[] {
    const entry = this.pluginTabs.get(inspectorId);
    if (!entry) return [];
    if (!this.selected) return [];
    if (!appliesToSafely(entry.inspector, this.selected)) return [];
    return runPluginInspector(entry.inspector, {
      scene: this.host,
      selection: this.selected,
    });
  }

  /** Run a plugin command by `<pluginId>/<commandId>` against the current selection. */
  public runCommand(qualifiedId: string): unknown {
    return runPluginCommand(qualifiedId, {
      scene: this.host,
      selection: this.selected ?? null,
    });
  }

  /** Change the auto-refresh cadence (ms; 0 disables). Also gates the reconcile. */
  public setRefreshInterval(ms: number): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    if (ms > 0) {
      this.refreshTimer = setInterval(() => this.refresh(), ms);
      // Disabling auto-refresh must disable the reconcile too, or `interval = 0`
      // would still leave a timer walking the tree every few seconds.
      this.reconcileTimer = setInterval(() => this.refresh(true), RECONCILE_INTERVAL_MS);
    }
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

    // Still apply the edit, but record that the parent owns this property so the
    // readout can say the value is about to be overwritten. Refusing the edit
    // outright would be worse: nudging a Stack child to see what moves is a
    // legitimate thing to try, and the useful behaviour is to let it happen and
    // explain why it did not stick.
    this.overriddenProp =
      prop !== 'opacity' && layoutControlledProperties(this.selected).includes(prop) ? prop : null;

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
    // A just-attempted edit to a parent-owned property gets a louder, transient
    // line than the static `*` marker: the user is looking at the panel right now
    // and about to conclude the editor is broken.
    if (this.overriddenProp) {
      const owner = entity.parent?.constructor.name ?? 'parent';
      // Inserted at the top, not appended: a full readout already occupies every
      // INSPECT_ROWS line, and the bounded write loop below would silently drop
      // an appended line — exactly the one the user is looking for right now.
      lines.splice(
        1,
        0,
        `! ${this.overriddenProp} is owned by ${owner}; this value reverts on the next layout`,
      );
    }
    for (let i = 0; i < this.detailLines.length; i++) {
      this.detailLines[i].setText(lines[i] ?? '');
    }
    this.writeA11y(entity);
  }

  /**
   * Fill the A11y tab: the selected entity's readout, then scene-wide findings.
   *
   * Audits run over the whole scene rather than the selection, because the two
   * most useful findings — a duplicate accessible name and a focusable node
   * clipped out of view — are relationships between entities and are invisible
   * when looking at one node at a time.
   */
  private writeA11y(entity: Entity): void {
    if (this.a11yLines.length === 0) return;
    const rows: string[] = [];
    try {
      const info = inspectA11y(this.host, entity);
      rows.push(
        info.projected
          ? `${info.tag ?? 'div'}${info.role ? ` role=${info.role}` : ''}`
          : 'not projected to the a11y tree',
      );
      if (info.accessibleName !== undefined) {
        rows.push(`name "${info.accessibleName}" (from ${info.nameSource})`);
      } else {
        rows.push('name — none —');
      }
      const flags: string[] = [];
      if (info.tabIndex !== undefined) flags.push(`tabIndex ${info.tabIndex}`);
      if (info.disabled !== undefined) flags.push(`disabled ${info.disabled}`);
      if (info.focused !== undefined) flags.push(`focused ${info.focused}`);
      if (info.readingOrder !== undefined) flags.push(`order #${info.readingOrder}`);
      if (flags.length > 0) rows.push(flags.join('  '));
      const cb = info.canvasBounds;
      rows.push(`canvas ${cb.x},${cb.y} ${cb.width}x${cb.height}`);
      if (info.domBounds) {
        const db = info.domBounds;
        rows.push(`dom    ${db.x},${db.y} ${db.width}x${db.height}`);
        // Assistive tech takes its geometry from the DOM node, so a divergence
        // means the focus ring lands where the user is not looking.
        const drift =
          Math.abs(db.width - cb.width) > 1 || Math.abs(db.height - cb.height) > 1
            ? ' ← diverges from canvas'
            : '';
        if (drift) rows.push(`!${drift}`);
      }

      const findings = this.a11yFindings();
      rows.push('');
      rows.push(
        findings.length === 0 ? 'audit: no findings' : `audit: ${findings.length} finding(s)`,
      );
      for (const finding of findings) {
        if (rows.length >= this.a11yLines.length) break;
        const marker = finding.entityId === entity.id ? '▸' : ' ';
        rows.push(`${marker} ${finding.kind}: ${finding.message.slice(0, 68)}`);
      }
    } catch (error) {
      // The audits walk app-supplied `getA11yAttributes()`; a throwing
      // implementation must not blank the panel.
      rows.push(`a11y readout failed: ${String(error).slice(0, 60)}`);
    }
    for (let i = 0; i < this.a11yLines.length; i++) {
      this.a11yLines[i].setText(rows[i] ?? '');
    }
  }

  /**
   * Full-scene a11y audit, cached across refresh ticks.
   *
   * `writeA11y` runs on every tick (it is the selected entity's readout), but
   * the audit walks the whole tree, so it used to pay a full-scene walk every
   * 500ms for results that were identical. The cache key carries every cheap
   * signal that can invalidate it: the host's structure version (the same one
   * `refresh()` keys on), the inspected entity (findings are rendered per
   * selection and highlight reuse means switching it moves no version), and a
   * staleness TTL — audit inputs include non-structural state (labels,
   * disabled, opacity, tabIndex, world bounds) that no version counter tracks,
   * so without the TTL a stale list could persist indefinitely (#705).
   */
  private a11yFindings(): A11yFinding[] {
    const version = this.host.structureVersion;
    const selectedId = this.selected?.id ?? null;
    const now = Date.now();
    if (
      version !== this.a11yAuditVersion ||
      selectedId !== this.a11yAuditSelectedId ||
      now - this.a11yAuditAt >= A11Y_AUDIT_TTL_MS
    ) {
      this.a11yAuditFindings = auditA11y(this.host);
      this.a11yAuditVersion = version;
      this.a11yAuditSelectedId = selectedId;
      this.a11yAuditAt = now;
    }
    return this.a11yAuditFindings;
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
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
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

/**
 * Whether an inspector claims this entity, treating a throwing `appliesTo` as
 * "does not apply" so one broken plugin cannot blank the whole panel.
 */
function appliesToSafely(inspector: PluginInspector, entity: Entity): boolean {
  try {
    return !inspector.appliesTo || inspector.appliesTo(entity) === true;
  } catch {
    return false;
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
 * Per-layer stroke colors.
 *
 * The renderer has no dash support, so layers can only be told apart by hue.
 * `aabb` keeps the original accent so an existing screenshot still reads the
 * same, and the rest run cool to warm roughly by how often a divergence in them
 * turns out to be the bug.
 */
const LAYER_COLORS: Record<HighlightLayerKind, string> = {
  aabb: ACCENT,
  layout: '#a78bfa',
  render: '#34d399',
  clip: '#fbbf24',
  content: '#f472b6',
  a11y: '#fb923c',
  hit: '#f87171',
};

/**
 * Selection outline drawn on the HOST scene's overlay layer.
 *
 * Draws each enabled geometry layer as a true polygon rather than a bounding
 * box, so a rotated entity shows its real edges and a box that has drifted from
 * the layout quad appears as its own outline instead of being averaged into one
 * rectangle.
 */
class HighlightEntity extends Entity {
  private target: Entity | null = null;
  private layerKinds: ReadonlyArray<HighlightLayerKind> = ['aabb'];
  private hitSampleStep: number | undefined;
  private cached: HighlightLayer[] = [];

  public track(target: Entity): void {
    this.target = target;
    this.cached = [];
  }

  public setLayers(kinds: ReadonlyArray<HighlightLayerKind>, hitSampleStep?: number): void {
    this.layerKinds = kinds;
    this.hitSampleStep = hitSampleStep;
    this.cached = [];
  }

  /** The layers computed on the most recent draw, for tests and the readout. */
  public get layers(): ReadonlyArray<HighlightLayer> {
    return this.cached;
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
    moveTo(x: number, y: number): void;
    lineTo(x: number, y: number): void;
    closePath(): void;
    roundRect(x: number, y: number, w: number, h: number, radius: number): void;
    stroke(color: string, width?: number): void;
    fill(color: string): void;
  }): void {
    const t = this.target;
    if (!t) return;
    const scene = t.scene as Scene | null;
    if (!scene) return;

    // Recomputed every draw rather than cached across frames: a dragged or
    // animated entity moves between frames, and an outline pointing at where it
    // used to be is worse than no outline.
    this.cached = highlightGeometry(scene, t, {
      layers: this.layerKinds,
      hitSampleStep: this.hitSampleStep,
    });

    for (const layer of this.cached) {
      const color = LAYER_COLORS[layer.kind];
      for (const polygon of layer.polygons) {
        const points = polygon.points;
        if (points.length < 2) continue;
        r.beginPath();
        r.moveTo(points[0]!.x, points[0]!.y);
        for (let i = 1; i < points.length; i++) r.lineTo(points[i]!.x, points[i]!.y);
        r.closePath();
        // Only the primary box gets a fill; washing every layer would stack
        // translucency until the entity underneath is unreadable.
        if (layer.kind === 'aabb' || layer.kind === 'layout') r.fill('rgba(56, 189, 248, 0.10)');
        r.stroke(color, layer.divergesFromLayout ? 2 : 1);
      }
    }
  }
}
