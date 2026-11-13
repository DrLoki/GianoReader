import { describe, it, expect, vi } from 'vitest';
import { TTSController } from './tts.js';

Element.prototype.scrollIntoView = function () {};

/** Translation panel: paragraphs 1..translated are translated, the rest still show the original text. */
function buildPanel(translated, pending) {
  const panel = document.createElement('div');
  for (let i = 1; i <= translated + pending; i++) {
    const p = document.createElement('p');
    p.setAttribute('data-idx', String(i));
    if (i <= translated) {
      p.textContent = `Translated ${i}`;
      p.setAttribute('data-translated', 'true');
    } else {
      p.textContent = `Originale ${i}`;
      p.classList.add('pending');
    }
    panel.appendChild(p);
  }
  return panel;
}

/** PRO controller whose engine is replaced by spies. `synthesize` resolves when `release()` is called. */
function buildProController(panel) {
  const controller = new TTSController();
  controller.init({
    originalViewer: document.createElement('div'),
    translationViewer: panel,
    settings: { panel: 'translation', mode: 'pro' },
    onTranslationNeeded: async () => {},
  });
  const pending = [];
  const engine = {
    synthesize: vi.fn((text) => new Promise((resolve) => {
      pending.push(() => resolve({ audioBuffer: { text }, rawMp3Bytes: null }));
    })),
    play: vi.fn(() => new Promise(() => {})), // keeps "playing" until the test ends
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
  };
  controller._proEngine = engine;
  const release = () => { const next = pending.shift(); if (next) next(); };
  return { controller, engine, release };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('PRO prefetch on the translation panel', () => {
  it('does not synthesize paragraphs that are not translated yet', () => {
    const { controller, engine } = buildProController(buildPanel(2, 3));
    controller._buildQueue();
    controller._currentIndex = 0;

    controller._prefetchAhead();

    const texts = engine.synthesize.mock.calls.map((call) => call[0]);
    expect(texts).toContain('Translated 2');
    expect(texts.some((text) => text.startsWith('Originale'))).toBe(false);
  });

  it('uses the translated text of a paragraph translated after the queue was built', () => {
    const panel = buildPanel(1, 2);
    const { controller, engine } = buildProController(panel);
    controller._buildQueue(); // paragraph 2 captured with its original text

    const second = panel.querySelector('[data-idx="2"]');
    second.textContent = 'Translated 2';
    second.setAttribute('data-translated', 'true');
    second.classList.remove('pending');

    controller._currentIndex = 0;
    controller._prefetchAhead();

    const texts = engine.synthesize.mock.calls.map((call) => call[0]);
    expect(texts).toContain('Translated 2');
    expect(texts).not.toContain('Originale 2');
  });
});

describe('pause while the audio is being synthesized', () => {
  it('plays the paragraph when playback is resumed', async () => {
    const { controller, engine, release } = buildProController(buildPanel(3, 0));

    controller.play();
    await tick();
    expect(engine.synthesize).toHaveBeenCalledTimes(1);

    controller.pause(); // the audio is not ready yet: nothing is playing
    release();
    await tick();
    expect(engine.play).not.toHaveBeenCalled();
    expect(controller.getState().status).toBe('paused');

    controller.play(); // resume
    await tick();

    expect(controller.getState().status).toBe('playing');
    expect(engine.play).toHaveBeenCalledTimes(1);
    expect(engine.play.mock.calls[0][0]).toEqual({ text: 'Translated 1' });
    // The audio synthesized during the pause is reused, not requested again
    const firstParagraphRequests = engine.synthesize.mock.calls.filter((call) => call[0] === 'Translated 1');
    expect(firstParagraphRequests).toHaveLength(1);

    controller.stop();
  });

  it('stop after a pause does not leave a pending restart', async () => {
    const { controller, engine, release } = buildProController(buildPanel(2, 0));

    controller.play();
    await tick();
    controller.pause();
    release();
    await tick();
    controller.stop();

    expect(controller.getState().status).toBe('idle');
    expect(controller._speakOnResume).toBe(false);
    expect(engine.play).not.toHaveBeenCalled();
  });
});
