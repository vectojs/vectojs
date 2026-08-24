import type { DisplaySpec } from './types';

export interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Multi-display layout inside one Scene. Displays are logical rectangles; the
 * shell paints one wallpaper spanning the union and constrains windows to a
 * chosen display's work area (display minus taskbar).
 */
export class DisplayLayout {
  private displays: DisplaySpec[];
  private taskbarHeight: number;
  private taskbarPosition: 'bottom' | 'top';

  constructor(
    displays: DisplaySpec[],
    sceneW: number,
    sceneH: number,
    taskbarHeight = 40,
    taskbarPosition: 'bottom' | 'top' = 'bottom',
  ) {
    this.taskbarHeight = taskbarHeight;
    this.taskbarPosition = taskbarPosition;
    this.displays =
      displays.length > 0
        ? displays.map((d) => ({ ...d }))
        : [{ id: 'primary', x: 0, y: 0, width: sceneW, height: sceneH }];
  }

  list(): readonly DisplaySpec[] {
    return this.displays;
  }

  primary(): DisplaySpec {
    return this.displays[0]!;
  }

  get(id: string): DisplaySpec | undefined {
    return this.displays.find((d) => d.id === id);
  }

  /**
   * Usable area on a display after subtracting the taskbar strip.
   */
  workArea(displayId?: string): WorkArea {
    const d = (displayId && this.get(displayId)) || this.primary();
    const tb = Math.min(this.taskbarHeight, d.height);
    if (this.taskbarPosition === 'top') {
      return { x: d.x, y: d.y + tb, width: d.width, height: d.height - tb };
    }
    return { x: d.x, y: d.y, width: d.width, height: d.height - tb };
  }

  /** Bounding box of all displays (wallpaper size). */
  bounds(): WorkArea {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const d of this.displays) {
      minX = Math.min(minX, d.x);
      minY = Math.min(minY, d.y);
      maxX = Math.max(maxX, d.x + d.width);
      maxY = Math.max(maxY, d.y + d.height);
    }
    return {
      x: minX,
      y: minY,
      width: Math.max(0, maxX - minX),
      height: Math.max(0, maxY - minY),
    };
  }

  /** Display that contains the point, or primary. */
  displayAt(x: number, y: number): DisplaySpec {
    for (const d of this.displays) {
      if (x >= d.x && x < d.x + d.width && y >= d.y && y < d.y + d.height) {
        return d;
      }
    }
    return this.primary();
  }

  /** Clamp a window rect into a display work area. */
  clampRect(
    x: number,
    y: number,
    w: number,
    h: number,
    displayId?: string,
  ): { x: number; y: number; width: number; height: number } {
    const area = this.workArea(displayId);
    const width = Math.min(Math.max(w, 1), area.width);
    const height = Math.min(Math.max(h, 1), area.height);
    const nx = Math.min(Math.max(x, area.x), area.x + area.width - width);
    const ny = Math.min(Math.max(y, area.y), area.y + area.height - height);
    return { x: nx, y: ny, width, height };
  }

  updateSceneSize(sceneW: number, sceneH: number): void {
    if (this.displays.length === 1 && this.displays[0]!.id === 'primary') {
      this.displays[0] = {
        id: 'primary',
        x: 0,
        y: 0,
        width: sceneW,
        height: sceneH,
      };
    }
  }
}
