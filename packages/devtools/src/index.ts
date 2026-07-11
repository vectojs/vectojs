import type { Scene } from '@vectojs/core';
import { DevtoolsPanel, type DevtoolsOptions } from './panel';

export { DevtoolsPanel, type DevtoolsOptions } from './panel';
export * from './headless';

/**
 * Attach the VMT inspector to a Scene. Returns the panel; call
 * `panel.destroy()` (or the returned `detach`) to remove it.
 *
 * @example
 * import { attachDevtools } from '@vectojs/devtools';
 * const devtools = attachDevtools(scene);
 * // …
 * devtools.detach();
 */
export function attachDevtools(
  scene: Scene,
  options?: DevtoolsOptions,
): DevtoolsPanel & { detach(): void } {
  const panel = new DevtoolsPanel(scene, options) as DevtoolsPanel & { detach(): void };
  panel.detach = () => panel.destroy();
  return panel;
}
