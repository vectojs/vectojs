// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { cssLineBoxBaseline } from '../src/text/Typography';

HTMLCanvasElement.prototype.getContext = (() => null) as never;

describe('cssLineBoxBaseline', () => {
  it('has a portable baseline fallback when browser font metrics are unavailable', () => {
    expect(cssLineBoxBaseline('16px sans-serif', 24)).toBeCloseTo(19.2);
  });
});
