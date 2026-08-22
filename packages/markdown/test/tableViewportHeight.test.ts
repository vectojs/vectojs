// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Table } from '@vectojs/ui';
import { Markdown } from '../src/Markdown';

/**
 * `tableViewportHeight` hands `Table` a fixed body viewport so it virtualizes its
 * rows. Asserted on the projected a11y role counts, because that is what the
 * option exists to bound: an unvirtualized `Table` pools a `row` plus one
 * `gridcell` per column for every row it holds, so the DOM cost of a table grows
 * linearly with its row count.
 */

interface Walkable {
  children?: Walkable[];
  getA11yAttributes?: () => { role?: string };
}

function countRoles(root: Walkable): Record<string, number> {
  const counts: Record<string, number> = {};
  const walk = (entity: Walkable): void => {
    const role = entity.getA11yAttributes?.().role;
    if (role) counts[role] = (counts[role] ?? 0) + 1;
    for (const child of entity.children ?? []) walk(child);
  };
  walk(root);
  return counts;
}

function tableDoc(rows: number): string {
  const lines = ['| Metric | Value | Notes |', '| --- | --- | --- |'];
  for (let i = 0; i < rows; i++) lines.push(`| metric ${i} | ${i} | note ${i} |`);
  return lines.join('\n');
}

function firstTable(md: Markdown): Table {
  const found = md.content.children.find((child): child is Table => child instanceof Table);
  if (!found) throw new Error('expected the document to contain a Table');
  return found;
}

describe('Markdown tableViewportHeight', () => {
  it('leaves tables unvirtualized by default, so hotspots scale with rows', () => {
    const small = countRoles(new Markdown(tableDoc(10), { maxWidth: 600 }) as never);
    const large = countRoles(new Markdown(tableDoc(60), { maxWidth: 600 }) as never);

    // 3 columns: one `row` per data row plus the header, one `gridcell` per body
    // cell, and `columnheader` for the header cells.
    expect(small.gridcell).toBe(30);
    expect(large.gridcell).toBe(180);
    expect(large.row).toBe(61);
  });

  it('bounds the projected hotspots once a viewport height is given', () => {
    const short = countRoles(
      new Markdown(tableDoc(10), { maxWidth: 600, tableViewportHeight: 300 }) as never,
    );
    const long = countRoles(
      new Markdown(tableDoc(60), { maxWidth: 600, tableViewportHeight: 300 }) as never,
    );

    // The pool now covers the viewport window plus overscan rather than the whole
    // table. The 10-row table is smaller than that window, so it still pools all
    // 30 of its cells; the 60-row one is capped well below its 180.
    expect(short.gridcell).toBe(30);
    expect(long.gridcell!).toBeLessThan(60);
    expect(long.row!).toBeLessThan(61);
  });

  it('holds the hotspot count flat as the row count keeps growing', () => {
    const at = (rows: number): number =>
      countRoles(new Markdown(tableDoc(rows), { maxWidth: 600, tableViewportHeight: 300 }) as never)
        .gridcell!;

    // The defect this option fixes is that the count is linear in rows. Bounded,
    // quadrupling the rows must not move it at all.
    expect(at(200)).toBe(at(50));
  });

  it('fixes the table height to the viewport instead of growing to fit', () => {
    const plain = firstTable(new Markdown(tableDoc(60), { maxWidth: 600 }));
    const virtual = firstTable(
      new Markdown(tableDoc(60), { maxWidth: 600, tableViewportHeight: 300 }),
    );

    expect(virtual.height).toBe(300);
    // The layout consequence the option's docs warn about, pinned so it cannot
    // change silently: the same table is far taller when it grows to fit.
    expect(plain.height).toBeGreaterThan(virtual.height);
  });

  it('ignores a non-positive or non-finite height rather than passing it through', () => {
    for (const value of [0, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
      const table = firstTable(
        new Markdown(tableDoc(20), { maxWidth: 600, tableViewportHeight: value }),
      );
      // Grow-to-fit, i.e. the default — never a zero-height or NaN scroll region.
      expect(Number.isFinite(table.height)).toBe(true);
      expect(table.height).toBeGreaterThan(300);
    }
  });

  it('virtualizes a table that lexes empty and grows through streaming', () => {
    // Every streamed table is first lexed with zero rows, when its delimiter row
    // arrives. `Table.viewportHeight` is readonly, so if that empty table were
    // built unvirtualized it could never become virtualized as rows stream in.
    const md = new Markdown('| Metric | Value | Notes |\n| --- | --- | --- |', {
      maxWidth: 600,
      tableViewportHeight: 300,
    });
    const table = firstTable(md);
    expect(table.height).toBe(300);

    md.setContent(tableDoc(60));
    const grown = firstTable(md);
    expect(grown.height).toBe(300);
    expect(countRoles(grown as never).gridcell!).toBeLessThan(60);
  });
});
