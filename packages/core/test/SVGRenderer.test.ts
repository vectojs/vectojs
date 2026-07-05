// @vitest-environment jsdom
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

  test('escapes every string sink without injecting SVG nodes or attributes', () => {
    const r = new SVGRenderer(800, 600);
    const payload = `red" onload="alert(1)'><script>bad()</script>&`;
    r.beginPath();
    r.moveTo(0, 0);
    r.lineTo(10, 10);
    r.fill(payload);
    r.stroke(payload);
    r.fillText(`<tspan onload="bad()">& text`, 0, 12, `12px ${payload}`, payload);
    const gradient = r.createLinearGradient(0, 0, 10, 10, [{ stop: 0, color: payload }]);
    r.beginPath();
    r.moveTo(0, 0);
    r.lineTo(20, 20);
    r.fill(gradient);
    r.drawImage({ src: 'javascript:alert(1)" onload="bad()' }, 0, 0, 10, 10);

    const xml = r.toXMLString();
    const document = new DOMParser().parseFromString(xml, 'image/svg+xml');

    expect(document.querySelector('parsererror')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('[onload]')).toBeNull();
    expect(document.querySelector('image')?.getAttribute('href')).toBe('#');
    expect(document.documentElement.textContent).toContain('<tspan onload="bad()">& text');
  });

  test('preserves raster canvas data while rejecting executable canvas data', () => {
    const r = new SVGRenderer(20, 20);
    r.drawImage({ toDataURL: () => 'data:image/png;base64,iVBORw0KGgo=' }, 0, 0, 10, 10);
    r.drawImage({ toDataURL: () => 'data:image/svg+xml,<svg onload="bad()"/>' }, 10, 0, 10, 10);

    const document = new DOMParser().parseFromString(r.toXMLString(), 'image/svg+xml');
    const hrefs = [...document.querySelectorAll('image')].map((node) => node.getAttribute('href'));
    expect(hrefs).toEqual(['data:image/png;base64,iVBORw0KGgo=', '#']);
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
