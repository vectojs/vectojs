import { describe, test, expect } from 'vitest';
import { SVGRenderer } from '../src/renderer/SVGRenderer';

describe('SVGRenderer', () => {
  test('should render basic shapes and matrices', () => {
    const r = new SVGRenderer(800, 600);
    r.clear();
    r.save();
    r.translate(10, 20);
    r.scale(2, 3);
    r.rotate(Math.PI / 2);
    r.beginPath();
    r.moveTo(0, 0);
    r.lineTo(100, 0);
    r.closePath();
    r.fill('#ff0000');
    r.restore();
    const xml = r.toXMLString();
    expect(xml).toContain('svg');
    expect(xml).toContain('transform="matrix(');
    expect(xml).toContain('fill="#ff0000"');
  });

  test('should escape special XML characters', () => {
    const r = new SVGRenderer(800, 600);
    r.fillText('<test & "hello" \'>', 0, 0, '12px Arial', '#000000');
    const xml = r.toXMLString();
    expect(xml).toContain('&lt;test &amp; &quot;hello&quot; &apos;&gt;');
  });

  test('should split 360 degree arcs into two half circles', () => {
    const r = new SVGRenderer(800, 600);
    r.beginPath();
    r.arc(50, 50, 10, 0, Math.PI * 2);
    r.fill('#0000ff');
    const xml = r.toXMLString();
    const count = (xml.match(/A 10 10/g) || []).length;
    expect(count).toBe(2);
  });
});
