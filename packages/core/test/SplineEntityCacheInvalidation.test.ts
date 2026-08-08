/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { SplineEntity, SplineDocument } from '../src/components/SplineEntity';

describe('SplineEntity cache invalidation', () => {
  const sampleDoc: SplineDocument = {
    type: 'Spline',
    equations: [
      {
        color_rgb: [1, 0, 0],
        data: [
          {
            start_t: 0,
            end_t: 1,
            x_poly: [0, 1, 0, 0],
            y_poly: [0, 0, 1, 0],
          },
        ],
      },
    ],
    bounding_box: [0, 0, 100, 100],
  };

  it('invalidates baked canvas when lineWidth changes', () => {
    const entity = new SplineEntity(sampleDoc, { lineWidth: 2, cache: true });
    // Access private fields via type assertion for testing
    const priv = entity as any;

    // Trigger initial bake by calling render (would normally happen in scene)
    // We can't actually render without a full scene setup, but we can verify
    // the cache invalidation mechanism directly
    priv.baked = true;
    priv.offscreen = {}; // mock canvas
    priv.polylines = [new Float32Array([0, 0, 1, 1])]; // mock polylines

    expect(priv.baked).toBe(true);
    expect(priv.offscreen).not.toBeNull();
    expect(priv.polylines).not.toBeNull();

    // Change lineWidth
    entity.lineWidth = 5;

    // Cache should be invalidated
    expect(priv.baked).toBe(false);
    expect(priv.offscreen).toBeNull();
    expect(priv.polylines).toBeNull();
  });

  it('does not invalidate cache when setting the same lineWidth', () => {
    const entity = new SplineEntity(sampleDoc, { lineWidth: 2 });
    const priv = entity as any;

    priv.baked = true;
    priv.offscreen = {};
    priv.polylines = [new Float32Array([0, 0, 1, 1])];

    // Set the same value
    entity.lineWidth = 2;

    // Cache should remain valid
    expect(priv.baked).toBe(true);
    expect(priv.offscreen).not.toBeNull();
    expect(priv.polylines).not.toBeNull();
  });

  it('invalidates all caches when doc changes', () => {
    const entity = new SplineEntity(sampleDoc, { cache: true });
    const priv = entity as any;

    priv.baked = true;
    priv.offscreen = {};
    priv.polylines = [new Float32Array([0, 0, 1, 1])];

    const newDoc: SplineDocument = {
      type: 'Spline',
      equations: [
        {
          color_rgb: [0, 1, 0],
          data: [
            {
              start_t: 0,
              end_t: 1,
              x_poly: [0, 2, 0, 0],
              y_poly: [0, 0, 2, 0],
            },
          ],
        },
      ],
      bounding_box: [0, 0, 200, 200],
    };

    // Change doc
    entity.doc = newDoc;

    // All caches should be invalidated
    expect(priv.baked).toBe(false);
    expect(priv.offscreen).toBeNull();
    expect(priv.polylines).toBeNull();
    // Bounds should also update
    expect(entity.width).toBe(200);
    expect(entity.height).toBe(200);
  });

  it('does not invalidate cache when setting the same doc', () => {
    const entity = new SplineEntity(sampleDoc);
    const priv = entity as any;

    priv.baked = true;
    priv.offscreen = {};
    priv.polylines = [new Float32Array([0, 0, 1, 1])];

    // Set the same doc
    entity.doc = sampleDoc;

    // Cache should remain valid
    expect(priv.baked).toBe(true);
    expect(priv.offscreen).not.toBeNull();
    expect(priv.polylines).not.toBeNull();
  });

  it('preserves getter/setter behavior for doc and lineWidth', () => {
    const entity = new SplineEntity(sampleDoc, { lineWidth: 3 });

    expect(entity.doc).toBe(sampleDoc);
    expect(entity.lineWidth).toBe(3);

    const newDoc: SplineDocument = {
      type: 'Polyline',
      paths: [
        {
          color_rgb: null,
          data: [
            { x: 0, y: 0 },
            { x: 10, y: 10 },
          ],
        },
      ],
    };

    entity.doc = newDoc;
    entity.lineWidth = 7;

    expect(entity.doc).toBe(newDoc);
    expect(entity.lineWidth).toBe(7);
  });
});
