import { test, expect } from 'vitest';
import { MSDFFont } from '../src/text/MSDFFont';
import { MSDFTextEntity } from '../src/text/MSDFTextEntity';
import fontJson from './fixtures/font.json';

test('MSDFTextEntity properties and boundary calculations', () => {
  const font = new MSDFFont(fontJson);
  const mockTexture = {} as TexImageSource;
  const entity = new MSDFTextEntity('Vecto', {
    font,
    texture: mockTexture,
    fontSize: 24,
  });

  expect(entity.isPointInside(10, 10)).toBe(false);
  entity.destroy();
});
