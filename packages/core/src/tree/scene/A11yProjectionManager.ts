/**
 * The a11y projection's DOM **ordering** engine: what order the projected
 * mirrors sit in, and what that reordering must not break.
 *
 * Extraction 2 of the `Scene.ts` decomposition
 * (`forge/decisions/file-decomposition-2026-08.md` §2), reduced in scope by
 * carryctx `DEC-0020`. `Scene` keeps `enforceA11yDomOrder` and
 * `a11yNeedsReorder` under their original names; the ordering half of the former
 * and the whole of the latter live here.
 *
 * ## What this owns
 *
 * The per-pass scratch collections (all reused rather than reallocated, which is
 * why they are fields and not locals), the reorder flag, the visual reading-order
 * sort, and the cursor-based `insertBefore` pass with its focus and `Selection`
 * preservation.
 *
 * ## What it deliberately does not own
 *
 * `Scene.enforceA11yDomOrder` still runs the collect-and-prune walk. Collecting
 * needs `shouldProjectA11y` — which reaches the pointer position (extraction 5)
 * and the content-projection tier (extraction 3) — and pruning needs
 * `focusedA11yElement`, `caretBlinkTimer` and `preserveFocusOnRemoval`. So
 * `Scene` walks and prunes, feeding each element in through {@link collect}, and
 * this class orders what it was given.
 *
 * Three members the original extraction plan assigned here stayed on `Scene`,
 * measured rather than assumed (`DEC-0020`):
 *
 * - `syncA11y` is not an a11y method. It is the shared depth-first walk driver
 *   for a11y **and** content projection: it calls `syncContentProjection` at its
 *   own recursion point and initialises four per-sync fields whose readers live
 *   in three other domains. It moves once extraction 3 has taken its co-driver
 *   out, not before — taking it now would need a back-edge into `Scene`, which
 *   `DEC-0019` rule 1 forbids.
 * - `removeA11yRecursively` deletes content projections and releases DOM portals,
 *   which are extraction 3 and the ninth portal domain respectively.
 * - `syncOverlayGeometry` is overlay-**layer** geometry: every dependency except
 *   `a11yRoot` (`canvas`, `glCanvas`, `gpuCanvas`, `width`, `height`) belongs to
 *   extraction 5. It sits under an a11y banner, which is a fourth instance of
 *   `DEC-0016`'s finding that the banners expose wrong cuts.
 *
 * ## Reading direction is passed in
 *
 * The inline sort is direction-sensitive and `_readingDirection` belongs to the
 * text/layout side of `Scene`, so {@link reorder} takes it as an argument rather
 * than reaching for it — `DEC-0019` rule 5, the same shape as
 * `WasmBackendFacade.report(webgpuActive)`.
 */

import type { Entity } from '../Entity';

export class A11yProjectionManager {
  /**
   * Set by anything that changes which elements exist or how they nest, and
   * cleared by the reorder pass. Public so `Scene` can expose it under its
   * original name: `Entity` assigns to `scene.a11yNeedsReorder` as a public
   * cross-class contract, so the flag needs a setter and not only
   * {@link markNeedsReorder}.
   */
  public needsReorder: boolean = true;

  /** Overlay mirrors, kept in insertion order — they cover everything, so the
   *  author's declared order is the right one. */
  private readonly fullViewportElements: HTMLElement[] = [];
  /** Everything else, sorted into visual reading order by {@link reorder}. */
  private readonly normalElements: HTMLElement[] = [];
  /** Ids collected this pass, read by `Scene`'s prune pass through
   *  {@link isActive}. */
  private readonly activeIdSet: Set<string> = new Set<string>();
  /** Per-parent insertion cursor, reused by {@link reorder}. */
  private readonly orderCursors: Map<Node, number> = new Map<Node, number>();
  /** Membership set for the elements being ordered, reused per reorder pass. */
  private readonly orderMembers: Set<HTMLElement> = new Set<HTMLElement>();
  /**
   * Elements that are an *ancestor* of another ordered element, reused per pass.
   *
   * A composite widget's container (a `grid` around its rows, a `tree` around its
   * items) spans every descendant row, so it must not extend a visual row band —
   * see {@link sortNormalElementsVisually}.
   */
  private readonly orderContainers: Set<HTMLElement> = new Set<HTMLElement>();
  /**
   * Nearest `clipChildren` ancestor per ordered element — its *region*. Written
   * by `Scene.enforceA11yDomOrder`'s collect walk through {@link collect}, which
   * already has the entity in hand, so a region costs one comparison per node
   * rather than an ancestor walk per element.
   *
   * Absent means the element sits under no clipping ancestor and belongs to the
   * implicit root region. See {@link sortNormalElementsVisually}.
   */
  private readonly orderRegions: Map<HTMLElement, Entity> = new Map<HTMLElement, Entity>();

  /** Mark the projected DOM as needing a reorder on the next pass. */
  public markNeedsReorder(): void {
    this.needsReorder = true;
  }

  /** Reset the per-pass collections. Zero-GC: length/clear, never reallocate. */
  public beginCollect(): void {
    this.fullViewportElements.length = 0;
    this.normalElements.length = 0;
    this.activeIdSet.clear();
    this.orderRegions.clear();
  }

  /**
   * Add one projected element to this pass.
   *
   * `region` is the nearest `clipChildren` ancestor, or `null` for the implicit
   * root region.
   */
  public collect(el: HTMLElement, fullViewport: boolean, region: Entity | null): void {
    if (fullViewport) this.fullViewportElements.push(el);
    else this.normalElements.push(el);
    if (region) this.orderRegions.set(el, region);
  }

  /** Record that `id` still has a live a11y mirror this pass. */
  public markActive(id: string): void {
    this.activeIdSet.add(id);
  }

  /** Whether `id` was collected this pass. Drives `Scene`'s prune pass. */
  public isActive(id: string): boolean {
    return this.activeIdSet.has(id);
  }

  /**
   * Put the collected elements into visual reading order in the DOM.
   *
   * No-op unless {@link needsReorder} is set; clears it on the way out.
   */
  public reorder(rtl: boolean): void {
    // Only reorder if the hierarchy flag is set
    if (!this.needsReorder) return;

    // Tab / screen-reader order must follow the *visual* reading order, not the
    // scene-graph insertion order in which we just collected the elements. Two
    // buttons added in any order but drawn side by side should Tab left→right
    // (or right→left under RTL). Sort the non-overlay elements by their synced
    // world position (top → row, then inline). Full-viewport overlays keep
    // insertion order (they cover everything, so their relative order is what
    // the author declared).
    this.sortNormalElementsVisually(rtl);

    const fullLen = this.fullViewportElements.length;
    const normalLen = this.normalElements.length;
    const totalLen = fullLen + normalLen;

    // Reorder nodes with zero allocations (no expectedOrder array or concats).
    //
    // Position is tracked per DOM parent rather than as one index into
    // `a11yRoot.childNodes`: composite widgets nest (a `gridcell` is a child of
    // its `row`, not of the root), so a single running index would compare a
    // nested element against whatever happened to sit at that offset under the
    // root and shuffle unrelated siblings on every frame. Walking the globally
    // sorted sequence and advancing each parent's own cursor gives every
    // container its children in global reading order, which is what document
    // order — and therefore Tab order — is read from.
    //
    // Filling each parent's indices from 0 upwards is also what keeps the focus
    // sentinel last: it is the one child of `a11yRoot` never collected here, so
    // every positioned element is placed before it.
    //
    // Moving a node also destroys any `Selection` anchored inside its subtree —
    // the same class of collateral damage as the focus loss handled below.
    // Measured in CTX-0207 with the document parked and the write head ~300
    // sections away: a selection held 176 chars across three sync passes and
    // collapsed in the exact pass that MOVED its carrier (`removedNodes` and
    // `addedNodes` both recorded the same node, `isConnected` stayed true, so no
    // eviction path was involved).
    //
    // The endpoints are snapshotted at most ONCE per pass, and only once a move
    // is actually about to happen. Reading any `Selection` property forces a
    // synchronous layout (CTX-0203 measured ~0.5ms per read in real Chrome, with
    // no cheap property to probe with), so the read is deliberately NOT hoisted
    // above the loop: a pass that reorders nothing — the steady state — pays
    // nothing at all. It must still precede the first `insertBefore`, because
    // after that the live endpoints are already gone.
    //
    // `contentSelectionPresentThisSync` is deliberately NOT used as the gate
    // here. That memo is invalidated by `syncA11y`, and this pass also runs in
    // frames where `syncA11y` is skipped (`a11yElements.size > 0` alone reaches
    // it), so it can hold a value describing an earlier frame.
    let selection: Selection | null = null;
    let selAnchorNode: Node | null = null;
    let selFocusNode: Node | null = null;
    let selAnchorOffset = 0;
    let selFocusOffset = 0;
    let selectionSnapshotTaken = false;
    let selectionMoved = false;

    this.orderCursors.clear();
    for (let i = 0; i < totalLen; i++) {
      const expected =
        i < fullLen ? this.fullViewportElements[i] : this.normalElements[i - fullLen];
      const parent = expected.parentNode;
      if (!parent) continue;
      const at = this.orderCursors.get(parent) ?? 0;
      this.orderCursors.set(parent, at + 1);
      const current = parent.childNodes[at];
      if (current !== expected) {
        // Moving a focused element blanks `document.activeElement`, and a
        // component whose keyboard contract rides an entity `keydown` listener
        // then stops receiving keys entirely — measured on `Dropdown`, whose
        // Escape-to-close (Dropdown.ts:95,123) silently died because opening the
        // popup reordered the mirror that held focus. Restore it after the move.
        const refocus = document.activeElement === expected;
        // Resolved on the first move of the pass and reused for the rest, so the
        // forced layout is paid once per REORDERING pass rather than once per
        // moved element. Inlined rather than factored into a helper closure: an
        // assignment made inside a closure is invisible to TypeScript's
        // control-flow analysis, which then narrows `selection` to `null` for the
        // whole function and rejects the restore below as a property access on
        // `never`.
        if (!selectionSnapshotTaken) {
          selectionSnapshotTaken = true;
          const live =
            typeof window !== 'undefined' && typeof window.getSelection === 'function'
              ? window.getSelection()
              : null;
          if (live?.anchorNode && live.focusNode) {
            selection = live;
            selAnchorNode = live.anchorNode;
            selFocusNode = live.focusNode;
            selAnchorOffset = live.anchorOffset;
            selFocusOffset = live.focusOffset;
          }
        }
        // A move only breaks the selection when an endpoint lives inside the
        // moved subtree, so each subsequent moved element costs one `contains`
        // against the snapshot — no further `Selection` access.
        if (
          !selectionMoved &&
          ((selAnchorNode !== null && expected.contains(selAnchorNode)) ||
            (selFocusNode !== null && expected.contains(selFocusNode)))
        ) {
          selectionMoved = true;
        }
        parent.insertBefore(expected, current || null);
        if (refocus) expected.focus({ preventScroll: true });
      }
    }

    // Restore after the whole pass rather than per move: a selection spanning
    // two carriers can have both of them moved, and re-applying between the two
    // would only be undone by the second move.
    //
    // A move preserves the text nodes themselves, so the snapshotted nodes and
    // offsets are still valid as-is. That is why this needs no offset remapping,
    // unlike `preserveContentSelectionAcrossRebuild`, which reasons in linear
    // character offsets because a rebuild replaces the nodes.
    if (selectionMoved && selection && selAnchorNode && selFocusNode) {
      try {
        selection.setBaseAndExtent(selAnchorNode, selAnchorOffset, selFocusNode, selFocusOffset);
      } catch {
        // Engine rejected the range — an endpoint detached by the prune pass, or
        // a shape it will not accept. Leaving the selection as the move left it
        // is the honest outcome; there is nothing valid to restore onto.
      }
    }

    this.needsReorder = false;
  }

  /**
   * Reorder `normalElements` (in place) into visual reading order using the
   * positions `syncA11y` already wrote to each element's inline style
   * (`top`/`left`/`height`). Elements are grouped into rows top-to-bottom (an
   * element belongs to the current row while its top is above the row's
   * running bottom edge), then sorted within a row by `left` — ascending for
   * `'ltr'`, descending for `'rtl'`. The sort is stable, so entities at the
   * same position keep their scene-graph (collection) order as a tiebreak.
   *
   * Those inline values are world coordinates for a top-level mirror but
   * PARENT-RELATIVE for a nested one, so this list mixes coordinate spaces.
   * That is sound because the result is only ever applied per DOM parent
   * ({@link reorder} advances a cursor per parent), and all of one parent's
   * children share one space: a `grid`'s rows are all grid-relative, a `row`'s
   * cells all row-relative. Comparisons ACROSS spaces do happen while banding,
   * but they only affect the relative order of elements in different parents,
   * which no `insertBefore` ever acts on. Normalizing everything back to world
   * coordinates here would cost a transform per element per frame to change
   * nothing observable.
   *
   * Banding runs **per region** — per nearest `clipChildren` ancestor, recorded
   * by `Scene.enforceA11yDomOrder`'s collect walk — rather than once over the
   * whole scene. Purely visual banding is right for a screen reader but wrong
   * for selection: a DOM `Selection` covers everything between anchor and focus
   * in DOM order, so under one global banding a vertical drag through a
   * transcript also swallowed a sidebar whose headings happened to fall in the
   * same rows. Regions are laid out side by side, so ordering region-major keeps
   * each one a contiguous DOM run and a drag stays inside it, while reading
   * order *within* a region is unchanged. Regions are emitted in the order their
   * clipper is first reached by the depth-first walk, so a screen reader still
   * meets them in the author's declared order.
   */
  private sortNormalElementsVisually(rtl: boolean): void {
    const els = this.normalElements;
    if (els.length < 2) return;

    // A zero-height mirror (rare) still needs a row band so same-top siblings
    // group together; clamp to a small minimum.
    const heightOf = (el: HTMLElement) => Math.max(Number.parseFloat(el.style.height) || 0, 4);

    // Identify which of these elements contain another one. Composite widgets
    // nest (`grid` > `row` > `gridcell`), and a container necessarily spans every
    // row it owns, so letting it extend a row band merges all of its rows into a
    // single band — after which the inline sort orders every cell by `left`
    // alone and yields column-major order. Walking ancestors is O(n · depth)
    // against the O(n log n) sort below, and the projection nests at most three
    // levels deep.
    const members = this.orderMembers;
    const containers = this.orderContainers;
    members.clear();
    containers.clear();
    for (const el of els) members.add(el);
    for (const el of els) {
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (members.has(p)) containers.add(p);
      }
    }

    // `top`/`left` are written **parent-relative** for a nested mirror (see
    // `rebaseChildBox`) and world-relative for a flat one, so the raw values are
    // not comparable across nesting levels: every `gridcell` inside a `row`
    // reports `top: 0`, which sorts all of them as if they sat at the top of the
    // document. Accumulate ancestor offsets to put every element back into one
    // space. The walk stops at the first ancestor that is not itself being
    // ordered, which is `a11yRoot`.
    const absolute = (el: HTMLElement): { top: number; left: number } => {
      let top = 0;
      let left = 0;
      for (let node: HTMLElement | null = el; node; node = node.parentElement) {
        top += Number.parseFloat(node.style.top) || 0;
        left += Number.parseFloat(node.style.left) || 0;
        const parent = node.parentElement;
        if (!parent || !members.has(parent)) break;
      }
      return { top, left };
    };

    // Decorate with the original index so the sort is stable across engines.
    const decorated = els.map((el, i) => {
      const { top, left } = absolute(el);
      return { el, i, top, left, container: containers.has(el) };
    });

    // Partition into regions, keeping first-encounter order. `normalElements` is
    // filled by a depth-first walk, so first encounter is the author's declared
    // order and a region's own members are already adjacent here.
    const regions = this.orderRegions;
    const buckets = new Map<Entity | null, (typeof decorated)[number][]>();
    for (const d of decorated) {
      const key = regions.get(d.el) ?? null;
      const bucket = buckets.get(key);
      if (bucket) bucket.push(d);
      else buckets.set(key, [d]);
    }

    const bandBottom = (r: (typeof decorated)[number]) =>
      r.top + (r.container ? 4 : heightOf(r.el));
    const sorted: HTMLElement[] = [];

    // Band within a region only, so a row never spans two regions.
    for (const order of buckets.values()) {
      order.sort((p, q) => p.top - q.top || p.i - q.i);

      // Bucket into visual rows by vertical overlap, then sort each row inline. A
      // container contributes its position — so it still sorts ahead of its own
      // descendants — but not its height, which is what keeps its rows separate.
      let rowStart = 0;
      let rowBottom = order.length ? bandBottom(order[0]) : 0;
      const flushRow = (end: number) => {
        const row = order.slice(rowStart, end);
        row.sort((p, q) => (rtl ? q.left - p.left : p.left - q.left) || p.i - q.i);
        for (const r of row) sorted.push(r.el);
      };
      for (let k = 1; k < order.length; k++) {
        if (order[k].top < rowBottom) {
          // Same row — extend the band to the tallest element seen so far.
          rowBottom = Math.max(rowBottom, bandBottom(order[k]));
        } else {
          flushRow(k);
          rowStart = k;
          rowBottom = bandBottom(order[k]);
        }
      }
      flushRow(order.length);
    }

    for (let i = 0; i < sorted.length; i++) els[i] = sorted[i];
  }
}
