import { Stack, StackOptions } from './Stack';

export interface FlowOptions extends Omit<StackOptions, 'direction' | 'wrap'> {
  direction?: 'horizontal';
}

/**
 * A layout container that arranges its children horizontally and wraps them to the
 * next line when the maximum width is exceeded.
 *
 * This is essentially a {@link Stack} configured with `direction: 'horizontal'`
 * and `wrap: true`. Set `maxWidth` to control the line break threshold.
 *
 * @example
 * const flow = new Flow({ gap: 8, maxWidth: 400 });
 * flow.add(tag1).add(tag2).add(tag3); // wraps when > 400px
 * scene.add(flow.setPosition(20, 20));
 */
export class Flow extends Stack {
  constructor(opts: FlowOptions = {}) {
    super({
      ...opts,
      direction: opts.direction ?? 'horizontal',
      wrap: true,
    });
  }
}
