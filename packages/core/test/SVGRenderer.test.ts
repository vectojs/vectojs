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

  describe('arc flag selection matches Canvas sweep semantics', () => {
    // Extract the flags of the first "A rx ry rot largeArc sweep x y" command.
    function arcFlags(draw: (r: SVGRenderer) => void): { largeArc: number; sweep: number } {
      const r = new SVGRenderer(800, 600);
      r.beginPath();
      draw(r);
      r.fill('#000');
      const m = r.toXMLString().match(/A [\d.]+ [\d.]+ 0 (\d) (\d)/);
      expect(m).not.toBeNull();
      return { largeArc: Number(m![1]), sweep: Number(m![2]) };
    }

    test('CW quarter arc stays small', () => {
      expect(arcFlags((r) => r.arc(50, 50, 10, 0, Math.PI / 2))).toEqual({
        largeArc: 0,
        sweep: 1,
      });
    });

    test('CW arc with endAngle < startAngle wraps to a large arc', () => {
      // Canvas sweeps clockwise from 0 down past 2π to -π/2 → 3π/2 travelled.
      expect(arcFlags((r) => r.arc(50, 50, 10, 0, -Math.PI / 2))).toEqual({
        largeArc: 1,
        sweep: 1,
      });
    });

    test('CCW arc with endAngle > startAngle wraps to a large arc', () => {
      // Counterclockwise from 0 to π/2 travels the long way: 3π/2.
      expect(arcFlags((r) => r.arc(50, 50, 10, 0, Math.PI / 2, true))).toEqual({
        largeArc: 1,
        sweep: 0,
      });
    });

    test('CCW quarter arc stays small', () => {
      expect(arcFlags((r) => r.arc(50, 50, 10, Math.PI / 2, 0, true))).toEqual({
        largeArc: 0,
        sweep: 0,
      });
    });

    test('CCW with a ≥2π positive delta is NOT a full circle', () => {
      // Canvas: CCW is a full circle only when start − end ≥ 2π. Here the
      // normalized CCW sweep is 3π/2 — a single large arc, not two halves.
      const r = new SVGRenderer(800, 600);
      r.beginPath();
      r.arc(50, 50, 10, 0, Math.PI * 2.5, true);
      r.fill('#000');
      const xml = r.toXMLString();
      expect((xml.match(/A 10 10/g) || []).length).toBe(1);
      expect(xml).toMatch(/A 10 10 0 1 0/);
    });

    test('CW with a ≥2π delta stays a full circle', () => {
      const r = new SVGRenderer(800, 600);
      r.beginPath();
      r.arc(50, 50, 10, 0, Math.PI * 2.5);
      r.fill('#000');
      expect((r.toXMLString().match(/A 10 10/g) || []).length).toBe(2);
    });
  });
});
