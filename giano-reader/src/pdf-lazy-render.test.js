import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock pdfjs-dist to avoid DOMMatrix dependency in test environment
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(),
}));

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
  default: '',
}));

const { renderPdfCanvas } = await import('./pdf.js');

/** Page whose render() is a spy and whose viewport is 600×800 at scale 1. */
function fakePage() {
  return {
    getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
  };
}

function fakeDoc(pageCount) {
  const pages = Array.from({ length: pageCount }, fakePage);
  return { pages, getPage: vi.fn(async (n) => pages[n - 1]) };
}

function container(width = 600) {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientWidth', { value: width });
  return el;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('renderPdfCanvas without IntersectionObserver', () => {
  it('paints every page right away', async () => {
    const doc = fakeDoc(3);
    const el = container();
    await renderPdfCanvas(doc, [1, 2, 3], el);

    expect(el.querySelectorAll('canvas')).toHaveLength(3);
    for (const page of doc.pages) expect(page.render).toHaveBeenCalledTimes(1);
  });
});

describe('renderPdfCanvas with IntersectionObserver', () => {
  let observers;

  beforeEach(() => {
    observers = [];
    globalThis.IntersectionObserver = class {
      constructor(callback, options) {
        this.callback = callback;
        this.options = options;
        this.targets = [];
        this.disconnected = false;
        observers.push(this);
      }
      observe(target) { this.targets.push(target); }
      disconnect() { this.disconnected = true; }
      /** Test helper: reports `target` as entering or leaving the viewport. */
      report(target, isIntersecting) { this.callback([{ target, isIntersecting }]); }
    };
  });

  afterEach(() => {
    delete globalThis.IntersectionObserver;
  });

  it('reserves the space of every page but paints none until it is near the viewport', async () => {
    const doc = fakeDoc(4);
    const el = container();
    await renderPdfCanvas(doc, [1, 2, 3, 4], el);

    const canvases = el.querySelectorAll('canvas');
    expect(canvases).toHaveLength(4);
    for (const canvas of canvases) {
      expect(canvas.style.width).toBe('600px');
      expect(canvas.style.height).toBe('800px');
    }
    for (const page of doc.pages) expect(page.render).not.toHaveBeenCalled();
    expect(observers[0].options.root).toBe(el);
    expect(observers[0].targets).toHaveLength(4);
  });

  it('paints a page when it comes near the viewport, once', async () => {
    const doc = fakeDoc(2);
    const el = container();
    await renderPdfCanvas(doc, [1, 2], el);
    const [first] = el.querySelectorAll('canvas');

    observers[0].report(first, true);
    await tick();
    observers[0].report(first, true);

    expect(doc.pages[0].render).toHaveBeenCalledTimes(1);
    expect(doc.pages[1].render).not.toHaveBeenCalled();
    expect(first.width).toBe(600);
    expect(first.height).toBe(800);
  });

  it('frees the bitmap of a page that scrolls far away and repaints it on return', async () => {
    const doc = fakeDoc(1);
    const el = container();
    await renderPdfCanvas(doc, [1], el);
    const canvas = el.querySelector('canvas');

    observers[0].report(canvas, true);
    await tick();
    observers[0].report(canvas, false);
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    expect(canvas.style.height).toBe('800px'); // layout unchanged

    observers[0].report(canvas, true);
    await tick();
    expect(doc.pages[0].render).toHaveBeenCalledTimes(2);
  });

  it('cancels a render still in progress when the page leaves', async () => {
    const doc = fakeDoc(1);
    const cancel = vi.fn();
    doc.pages[0].render = vi.fn(() => ({ promise: new Promise(() => {}), cancel }));
    const el = container();
    await renderPdfCanvas(doc, [1], el);
    const canvas = el.querySelector('canvas');

    observers[0].report(canvas, true);
    observers[0].report(canvas, false);

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('stops the previous observer when the container is rendered again', async () => {
    const el = container();
    await renderPdfCanvas(fakeDoc(2), [1, 2], el);
    await renderPdfCanvas(fakeDoc(1), [1], el);

    expect(observers).toHaveLength(2);
    expect(observers[0].disconnected).toBe(true);
    expect(observers[1].disconnected).toBe(false);
    expect(el.querySelectorAll('canvas')).toHaveLength(1);
  });

  it('uses the device pixel ratio for a sharp page on HiDPI screens', async () => {
    const original = window.devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    try {
      const doc = fakeDoc(1);
      const el = container();
      await renderPdfCanvas(doc, [1], el);
      const canvas = el.querySelector('canvas');
      observers[0].report(canvas, true);
      await tick();

      expect(canvas.width).toBe(1200);
      expect(canvas.style.width).toBe('600px');
      expect(doc.pages[0].render.mock.calls[0][0].transform).toEqual([2, 0, 0, 2, 0, 0]);
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', { value: original, configurable: true });
    }
  });
});
