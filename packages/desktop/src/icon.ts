import { SVGEntity } from '@vectojs/core';
import { Button } from '@vectojs/ui';

/** Attach a decorative SVG icon to a button while keeping its label semantic. */
export function addButtonIcon(
  button: Button,
  source: string,
  size: number,
  color?: string,
): SVGEntity {
  const icon = new SVGEntity(color ? source.replaceAll('currentColor', color) : source);
  icon.width = size;
  icon.height = size;
  icon.x =
    button.textWidth === 0
      ? Math.round((button.width - size) / 2)
      : Math.max(4, Math.round((button.width - button.textWidth) / 2 - size - 6));
  icon.y = Math.round((button.height - size) / 2);
  icon.interactive = false;
  icon.a11yProjection = 'never';
  button.add(icon);
  return icon;
}

/** Built-in window command icons use paths rather than platform font glyphs. */
export const WINDOW_ICONS = {
  minimize:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M5 17h14v2H5z" fill="currentColor"/></svg>',
  maximize:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M5 5h14v14H5z" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  close:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
} as const;
