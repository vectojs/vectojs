import { Stack, StackOptions } from './Stack';

export interface FlowOptions extends Omit<StackOptions, 'direction' | 'wrap'> {
  direction?: 'horizontal';
}

/**
 * A layout container that arranges its children horizontally and wraps them to the
 * next line when the maximum width is exceeded.
 * This is essentially a Stack configured with direction: 'horizontal' and wrap: true.
 */
export class Flow extends Stack {
  constructor(opts: FlowOptions = {}) {
    super({
      ...opts,
      direction: opts.direction ?? 'horizontal',
      wrap: true,
    });
    this.id = this.id.replace('entity_', 'flow_');
  }
}
