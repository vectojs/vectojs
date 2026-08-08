import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerFencedBlockRenderer,
  unregisterFencedBlockRenderer,
  hasFencedBlockRenderer,
  isFencedBlockRendererReady,
  ensureFencedBlockRenderer,
  renderFencedBlock,
  type FencedBlockRenderer,
} from '../src/markdown-fenced-registry';
import { Entity } from '@vectojs/core';

describe('FencedBlockRegistry', () => {
  describe('registration', () => {
    beforeEach(() => {
      // Clean up any test renderers
      unregisterFencedBlockRenderer('test-lang');
      unregisterFencedBlockRenderer('test-async');
    });

    it('registers a renderer', () => {
      const renderer: FencedBlockRenderer = () => new Entity();
      registerFencedBlockRenderer('test-lang', {
        async load() {
          return renderer;
        },
      });

      expect(hasFencedBlockRenderer('test-lang')).toBe(true);
    });

    it('normalizes language to lowercase', () => {
      const renderer: FencedBlockRenderer = () => new Entity();
      registerFencedBlockRenderer('TEST-LANG', {
        async load() {
          return renderer;
        },
      });

      expect(hasFencedBlockRenderer('test-lang')).toBe(true);
      expect(hasFencedBlockRenderer('TEST-LANG')).toBe(true);
    });

    it('unregisters a renderer', () => {
      const renderer: FencedBlockRenderer = () => new Entity();
      registerFencedBlockRenderer('test-lang', {
        async load() {
          return renderer;
        },
      });

      expect(hasFencedBlockRenderer('test-lang')).toBe(true);
      unregisterFencedBlockRenderer('test-lang');
      expect(hasFencedBlockRenderer('test-lang')).toBe(false);
    });
  });

  describe('lazy loading', () => {
    beforeEach(() => {
      unregisterFencedBlockRenderer('test-async');
    });

    it('loads a renderer on demand', async () => {
      const renderer: FencedBlockRenderer = () => new Entity();
      registerFencedBlockRenderer('test-async', {
        async load() {
          return renderer;
        },
      });

      expect(isFencedBlockRendererReady('test-async')).toBe(false);
      await ensureFencedBlockRenderer('test-async');
      expect(isFencedBlockRendererReady('test-async')).toBe(true);
    });

    it('caches the load promise (multiple calls join one load)', async () => {
      let loadCount = 0;
      const renderer: FencedBlockRenderer = () => new Entity();
      registerFencedBlockRenderer('test-async', {
        async load() {
          loadCount++;
          return renderer;
        },
      });

      // Call ensureFencedBlockRenderer multiple times
      await Promise.all([
        ensureFencedBlockRenderer('test-async'),
        ensureFencedBlockRenderer('test-async'),
        ensureFencedBlockRenderer('test-async'),
      ]);

      expect(loadCount).toBe(1);
    });

    it('handles load failures gracefully', async () => {
      registerFencedBlockRenderer('test-fail', {
        async load() {
          throw new Error('Load failed');
        },
      });

      await ensureFencedBlockRenderer('test-fail');
      expect(isFencedBlockRendererReady('test-fail')).toBe(false);
    });
  });

  describe('rendering', () => {
    beforeEach(() => {
      unregisterFencedBlockRenderer('test-render');
    });

    it('renders with a ready renderer', async () => {
      const testEntity = new Entity();
      const renderer: FencedBlockRenderer = () => testEntity;
      registerFencedBlockRenderer('test-render', {
        async load() {
          return renderer;
        },
      });

      await ensureFencedBlockRenderer('test-render');

      const result = renderFencedBlock('source', 'test-render', {
        theme: {} as any,
        availableWidth: 800,
        selectable: true,
      });

      expect(result).toBe(testEntity);
    });

    it('returns null for unregistered language', () => {
      const result = renderFencedBlock('source', 'unknown-lang', {
        theme: {} as any,
        availableWidth: 800,
        selectable: true,
      });

      expect(result).toBeNull();
    });

    it('returns null for renderer not loaded yet', () => {
      registerFencedBlockRenderer('test-not-loaded', {
        async load() {
          return () => new Entity();
        },
      });

      const result = renderFencedBlock('source', 'test-not-loaded', {
        theme: {} as any,
        availableWidth: 800,
        selectable: true,
      });

      expect(result).toBeNull();
    });

    it('returns null when renderer returns null', async () => {
      const renderer: FencedBlockRenderer = () => null;
      registerFencedBlockRenderer('test-null', {
        async load() {
          return renderer;
        },
      });

      await ensureFencedBlockRenderer('test-null');

      const result = renderFencedBlock('', 'test-null', {
        theme: {} as any,
        availableWidth: 800,
        selectable: true,
      });

      expect(result).toBeNull();
    });
  });

  describe('built-in renderers', () => {
    it('has code block renderers registered', () => {
      expect(hasFencedBlockRenderer('javascript')).toBe(true);
      expect(hasFencedBlockRenderer('python')).toBe(true);
      expect(hasFencedBlockRenderer('rust')).toBe(true);
    });

    it('has math renderers registered', () => {
      expect(hasFencedBlockRenderer('math')).toBe(true);
      expect(hasFencedBlockRenderer('latex')).toBe(true);
      expect(hasFencedBlockRenderer('tex')).toBe(true);
    });
  });
});
