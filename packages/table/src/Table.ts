import { Table as UiTable, type ColumnAlign, type TableOptions } from '@vectojs/ui';

/**
 * Standalone package surface for the complete canvas-native Table.
 *
 * UiTable owns the implementation, including virtualization, grid a11y,
 * selectable cell projections, appendRows, and width/layout behavior. The
 * subclass gives this package its own public constructor while keeping the
 * aggregate @vectojs/ui import and behavior unchanged.
 */
export class Table extends UiTable {}

export type { ColumnAlign, TableOptions };
