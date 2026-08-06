import { Entity, IRenderer } from '@vectojs/core';

/**
 * Leaf entities the Markdown renderer composes: the `<hr>` rule, the blockquote
 * accent bar, and a bare container for nested layouts.
 *
 * These live outside `Markdown.ts` because `MathBlock` extends
 * `MarkdownContainer`. With the base class declared in `Markdown.ts`, a math
 * module importing it back forms a cycle that resolves the binding to
 * `undefined` when the `extends` clause is evaluated, throwing `TypeError:
 * Class extends value undefined is not a constructor or null` on import.
 * Verified by reintroducing it deliberately. 22 of 27 test files enter through
 * `../src/Markdown`, which is the order that trips it. See
 * `forge/decisions/file-decomposition-2026-08.md`.
 */

/** A thin horizontal line (for `<hr>`). */
export class HorizontalRule extends Entity {
  color: string;
  constructor(w: number, color: string) {
    super();
    this.width = w;
    this.height = 1;
    this.color = color;
  }
  isPointInside(): boolean {
    return false;
  }
  render(r: IRenderer): void {
    r.beginPath();
    r.moveTo(0, 0);
    r.lineTo(this.width, 0);
    r.stroke(this.color, 1);
  }
}

/** A vertical accent bar for blockquotes. */
export class QuoteBorder extends Entity {
  color: string;
  constructor(height: number, color: string, width = 4) {
    super();
    this.width = width;
    this.height = height;
    this.color = color;
  }
  isPointInside(): boolean {
    return false;
  }
  render(r: IRenderer): void {
    // Radius is half the bar width, so the cap stays a semicircle at any width.
    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, this.width / 2);
    r.fill(this.color);
  }
}

/** A simple concrete container entity for nested layouts. */
export class MarkdownContainer extends Entity {
  isPointInside(_globalX: number, _globalY: number): boolean {
    return false;
  }
  render(_r: any): void {}
}
