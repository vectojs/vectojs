if (typeof HTMLCanvasElement !== 'undefined') {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    writable: true,
    value(this: HTMLCanvasElement, type: string) {
      if (type !== '2d') return null;
      return new Proxy(
        { canvas: this },
        {
          get(target, property) {
            if (property === 'canvas') return target.canvas;
            if (property === 'measureText') return (text: string) => ({ width: text.length * 8 });
            if (property === 'createLinearGradient') return () => ({ addColorStop() {} });
            return () => {};
          },
          set() {
            return true;
          },
        },
      );
    },
  });
}
