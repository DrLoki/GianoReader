/**
 * tts.test.js
 *
 * Bug condition exploration test for TTS translate-before-reading.
 * 
 * **Validates: Requirements 1.1, 1.2, 1.3**
 *
 * Bug Condition: When TTS is playing on the translation panel and encounters
 * a paragraph with class `pending` (untranslated), it reads the original-language
 * text instead of waiting for translation.
 *
 * This test MUST FAIL on unfixed code — failure confirms the bug exists.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fc from 'fast-check';
import { TTSController } from './tts.js';

// Stub scrollIntoView (not available in jsdom)
Element.prototype.scrollIntoView = function () {};

// ---------------------------------------------------------------------------
// Helpers: Build a mock DOM for the translation panel
// ---------------------------------------------------------------------------

/**
 * Creates a mock translation panel with translated and pending paragraphs.
 * @param {number} translatedCount - Number of already-translated paragraphs (from index 1)
 * @param {number} pendingCount - Number of pending (untranslated) paragraphs after translated ones
 * @returns {{ panel: HTMLElement, translatedTexts: string[], originalTexts: string[] }}
 */
function buildTranslationPanel(translatedCount, pendingCount) {
  const panel = document.createElement('div');
  panel.id = 'translation-viewer';

  const translatedTexts = [];
  const originalTexts = [];

  // Create translated paragraphs (indices 1..translatedCount)
  for (let i = 1; i <= translatedCount; i++) {
    const p = document.createElement('p');
    p.setAttribute('data-idx', String(i));
    const translatedText = `Translated paragraph ${i} in English`;
    p.textContent = translatedText;
    // No 'pending' class — these are translated
    p.setAttribute('data-translated', 'true');
    panel.appendChild(p);
    translatedTexts.push(translatedText);
  }

  // Create pending paragraphs (indices translatedCount+1..translatedCount+pendingCount)
  for (let i = translatedCount + 1; i <= translatedCount + pendingCount; i++) {
    const p = document.createElement('p');
    p.setAttribute('data-idx', String(i));
    const originalText = `Capitolo ${i} contenuto originale in italiano`;
    p.textContent = originalText;
    p.classList.add('pending');
    panel.appendChild(p);
    originalTexts.push(originalText);
  }

  return { panel, translatedTexts, originalTexts };
}

/**
 * Creates a minimal original panel (empty, for init purposes).
 */
function buildOriginalPanel() {
  const panel = document.createElement('div');
  panel.id = 'original-viewer';
  return panel;
}

/**
 * Mock SpeechSynthesis and SpeechSynthesisUtterance for the FREE engine.
 * Captures what text is spoken.
 */
function mockWebSpeechAPI() {
  const spokenTexts = [];

  // Mock SpeechSynthesisUtterance
  global.SpeechSynthesisUtterance = class {
    constructor(text) {
      this.text = text;
      this.voice = null;
      this.rate = 1.0;
      this.pitch = 1.0;
      this.onend = null;
      this.onerror = null;
    }
  };

  // Mock speechSynthesis
  const mockSynth = {
    speaking: false,
    paused: false,
    getVoices: () => [{
      voiceURI: 'English (US)',
      lang: 'en-US',
      name: 'English US',
      localService: true
    }],
    speak: (utterance) => {
      spokenTexts.push(utterance.text);
      mockSynth.speaking = true;
      // Simulate async completion
      setTimeout(() => {
        mockSynth.speaking = false;
        if (utterance.onend) utterance.onend();
      }, 0);
    },
    pause: () => { mockSynth.paused = true; },
    resume: () => { mockSynth.paused = false; },
    cancel: () => { mockSynth.speaking = false; }
  };

  Object.defineProperty(window, 'speechSynthesis', {
    value: mockSynth,
    writable: true,
    configurable: true
  });

  return { spokenTexts, mockSynth };
}

// ---------------------------------------------------------------------------
// Bug Condition Exploration Test
// ---------------------------------------------------------------------------

describe('Bug Condition: TTS Reads Untranslated Pending Paragraphs', () => {
  let spokenTexts;
  let mockSynth;

  beforeEach(() => {
    // Set up localStorage for settings
    const settings = {
      ttsMode: 'free',
      ttsPanel: 'translation',
      targetLang: 'en',
      sourceLang: 'it'
    };
    localStorage.setItem('giano-reader-settings', JSON.stringify(settings));

    // Set up Web Speech API mock
    ({ spokenTexts, mockSynth } = mockWebSpeechAPI());
  });

  /**
   * Property 1: Bug Condition — TTS Reads Untranslated Pending Paragraphs
   *
   * For all paragraph indices where isBugCondition holds (paragraph has class
   * `pending` on translation panel), assert that _speakCurrent() waits for
   * translation and reads translated text (not original text).
   *
   * **Validates: Requirements 1.1, 1.2, 1.3**
   */
  it('Property: TTS on translation panel should read translated text, not original text from pending paragraphs', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate a pending paragraph index (1-based, within the pending range 13-24)
        fc.integer({ min: 13, max: 24 }),
        async (pendingIdx) => {
          // Reset spoken texts for each run
          spokenTexts.length = 0;

          // Build DOM: paragraphs 1-12 translated, 13-24 pending
          const { panel: translationPanel, originalTexts } = buildTranslationPanel(12, 12);
          const originalPanel = buildOriginalPanel();

          // Append to document so querySelector works
          document.body.innerHTML = '';
          document.body.appendChild(originalPanel);
          document.body.appendChild(translationPanel);

          // Mock onTranslationNeeded: simulates translation by removing 'pending'
          // class and updating textContent for paragraphs in the requested range
          const onTranslationNeeded = (startIdx, endIdx) => {
            for (let idx = startIdx; idx <= endIdx; idx++) {
              const el = translationPanel.querySelector(`[data-idx="${idx}"]`);
              if (el && el.classList.contains('pending')) {
                el.textContent = `Translated paragraph ${idx} in English`;
                el.setAttribute('data-translated', 'true');
                el.classList.remove('pending');
              }
            }
          };

          // Create a fresh TTS controller
          const controller = new TTSController();
          controller.init({
            originalViewer: originalPanel,
            translationViewer: translationPanel,
            settings: { panel: 'translation', mode: 'free' },
            onStateChange: () => {},
            onError: () => {},
            onTranslationNeeded
          });

          // Build the queue
          controller._buildQueue();

          // Find the queue index that corresponds to our pending paragraph
          const queueIndex = controller._paragraphs.findIndex(
            p => p.index === pendingIdx
          );

          // The pending paragraph must be in the queue
          expect(queueIndex).toBeGreaterThanOrEqual(0);

          // Set the current index to the pending paragraph
          controller._currentIndex = queueIndex;
          controller._state = 'playing';

          // Speak the current paragraph
          await new Promise((resolve) => {
            // Override _advanceToNext to capture when speech completes
            controller._advanceToNext = () => { resolve(); };
            controller._speakCurrent();
          });

          // The text that was spoken
          const spokenText = spokenTexts[spokenTexts.length - 1];

          // After fix: pending class should have been removed by translation mock
          const paragraphEl = translationPanel.querySelector(`[data-idx="${pendingIdx}"]`);
          expect(paragraphEl.classList.contains('pending')).toBe(false);

          // EXPECTED BEHAVIOR:
          // TTS should NOT read the original-language text from the pending paragraph.
          // It should wait for translation and read translated text.
          const originalText = `Capitolo ${pendingIdx} contenuto originale in italiano`;
          expect(spokenText).not.toBe(originalText);
          // Assert TTS read the translated text
          expect(spokenText).toBe(`Translated paragraph ${pendingIdx} in English`);
        }
      ),
      { numRuns: 12 } // One run per pending paragraph index
    );
  });

  /**
   * Concrete test case: Build queue from translation panel, advance TTS to
   * paragraph index 13 (first pending), assert the text passed to the speech
   * engine is translated text, not original Italian text.
   *
   * **Validates: Requirements 1.1, 1.3**
   */
  it('Concrete: TTS at paragraph 13 (pending) should not read original Italian text', async () => {
    spokenTexts.length = 0;

    // Build DOM: paragraphs 1-12 translated, 13-24 pending
    const { panel: translationPanel } = buildTranslationPanel(12, 12);
    const originalPanel = buildOriginalPanel();

    document.body.innerHTML = '';
    document.body.appendChild(originalPanel);
    document.body.appendChild(translationPanel);

    // Mock onTranslationNeeded: simulates translation by removing 'pending'
    // class and updating textContent for paragraphs in the requested range
    const onTranslationNeeded = (startIdx, endIdx) => {
      for (let idx = startIdx; idx <= endIdx; idx++) {
        const el = translationPanel.querySelector(`[data-idx="${idx}"]`);
        if (el && el.classList.contains('pending')) {
          el.textContent = `Translated paragraph ${idx} in English`;
          el.setAttribute('data-translated', 'true');
          el.classList.remove('pending');
        }
      }
    };

    // Create TTS controller on translation panel
    const controller = new TTSController();
    controller.init({
      originalViewer: originalPanel,
      translationViewer: translationPanel,
      settings: { panel: 'translation', mode: 'free' },
      onStateChange: () => {},
      onError: () => {},
      onTranslationNeeded
    });

    // Build queue
    controller._buildQueue();

    // Verify paragraph 13 is in the queue and is pending
    const queueIdx = controller._paragraphs.findIndex(p => p.index === 13);
    expect(queueIdx).toBeGreaterThanOrEqual(0);

    const paragraphEl = translationPanel.querySelector('[data-idx="13"]');
    expect(paragraphEl.classList.contains('pending')).toBe(true);

    // Set TTS to paragraph 13
    controller._currentIndex = queueIdx;
    controller._state = 'playing';

    // Speak the paragraph
    await new Promise((resolve) => {
      controller._advanceToNext = () => { resolve(); };
      controller._speakCurrent();
    });

    const spokenText = spokenTexts[spokenTexts.length - 1];

    // BUG ASSERTION: The text spoken should be translated, NOT the original Italian
    const originalItalianText = 'Capitolo 13 contenuto originale in italiano';
    const expectedTranslatedText = 'Translated paragraph 13 in English';

    // Assert TTS did NOT read the original language text
    expect(spokenText).not.toBe(originalItalianText);
    // Assert TTS read translated text
    expect(spokenText).toBe(expectedTranslatedText);
  });
});


// ---------------------------------------------------------------------------
// Preservation Property Tests
// ---------------------------------------------------------------------------

/**
 * Preservation Property Tests — Non-Pending Paragraph and Original Panel Behavior
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**
 *
 * These tests MUST PASS on unfixed code to confirm baseline behavior to preserve.
 * They ensure the fix does not regress existing TTS behavior for:
 * - Original panel playback (no translation checks)
 * - Translation panel with all paragraphs already translated (no delays)
 * - Stop/pause responsiveness (immediate state transitions)
 */
describe('Preservation: Non-Pending Paragraph and Original Panel Behavior', () => {
  let spokenTexts;
  let mockSynth;

  beforeEach(() => {
    vi.useFakeTimers();

    // Set up localStorage for settings
    const settings = {
      ttsMode: 'free',
      ttsPanel: 'original',
      sourceLang: 'it',
      targetLang: 'en'
    };
    localStorage.setItem('giano-reader-settings', JSON.stringify(settings));

    // Set up Web Speech API mock
    ({ spokenTexts, mockSynth } = mockWebSpeechAPISync());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Property: For all panel="original" with any paragraph state, TTS reads
   * paragraphs sequentially without translation checks (no call to
   * `onTranslationNeeded`, no delays).
   *
   * **Validates: Requirements 3.1**
   */
  it('Property: Original panel reads all paragraphs sequentially without translation checks', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate random chapter length (1–100 paragraphs)
        fc.integer({ min: 1, max: 100 }),
        // Generate random number of paragraphs with 'pending' class (shouldn't matter for original panel)
        fc.integer({ min: 0, max: 100 }),
        async (totalParagraphs, pendingCount) => {
          // Clamp pendingCount to totalParagraphs
          const actualPending = Math.min(pendingCount, totalParagraphs);

          // Reset spoken texts
          spokenTexts.length = 0;

          // Build original panel with random paragraphs (some may have 'pending' class — irrelevant for original panel)
          const { originalPanel, translationPanel } = buildPanelsForOriginal(totalParagraphs, actualPending);

          document.body.innerHTML = '';
          document.body.appendChild(originalPanel);
          document.body.appendChild(translationPanel);

          // Create TTS controller on original panel
          const onTranslationNeeded = vi.fn();
          const controller = new TTSController();
          controller.init({
            originalViewer: originalPanel,
            translationViewer: translationPanel,
            settings: { panel: 'original', mode: 'free' },
            onStateChange: () => {},
            onError: () => {}
          });
          // Attach translation callback (should never be called)
          controller._onTranslationNeeded = onTranslationNeeded;

          // Start playback
          controller.play();

          // Drain all microtasks — the mock speech fires onend synchronously via timers
          await drainAllSpeech(controller, totalParagraphs);

          // Verify: all paragraphs were spoken in order
          expect(spokenTexts.length).toBe(totalParagraphs);
          for (let i = 0; i < totalParagraphs; i++) {
            expect(spokenTexts[i]).toBe(`Original paragraph ${i + 1}`);
          }

          // Verify: no translation logic was invoked
          expect(onTranslationNeeded).not.toHaveBeenCalled();

          // Verify: controller returned to idle state
          expect(controller.getState().status).toBe('idle');

          // Clean up
          controller.destroy();
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * Property: For all panel="translation" where NO paragraph has class `pending`,
   * TTS reads sequentially without added delays (identical to current behavior).
   *
   * **Validates: Requirements 3.2**
   */
  it('Property: Translation panel with all translated paragraphs reads sequentially without delays', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate random chapter length (1–100 paragraphs)
        fc.integer({ min: 1, max: 100 }),
        async (totalParagraphs) => {
          // Reset spoken texts
          spokenTexts.length = 0;

          // Build translation panel with ALL paragraphs translated (no 'pending' class)
          const { originalPanel, translationPanel } = buildPanelsAllTranslated(totalParagraphs);

          document.body.innerHTML = '';
          document.body.appendChild(originalPanel);
          document.body.appendChild(translationPanel);

          // Update localStorage to indicate translation panel
          const settings = JSON.parse(localStorage.getItem('giano-reader-settings'));
          settings.ttsPanel = 'translation';
          localStorage.setItem('giano-reader-settings', JSON.stringify(settings));

          // Create TTS controller on translation panel
          const controller = new TTSController();
          controller.init({
            originalViewer: originalPanel,
            translationViewer: translationPanel,
            settings: { panel: 'translation', mode: 'free' },
            onStateChange: () => {},
            onError: () => {}
          });

          // Start playback
          controller.play();

          // Drain all speech
          await drainAllSpeech(controller, totalParagraphs);

          // Verify: all paragraphs were spoken in order with translated text
          expect(spokenTexts.length).toBe(totalParagraphs);
          for (let i = 0; i < totalParagraphs; i++) {
            expect(spokenTexts[i]).toBe(`Translated paragraph ${i + 1}`);
          }

          // Verify: controller returned to idle state
          expect(controller.getState().status).toBe('idle');

          // Clean up
          controller.destroy();
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * Property: For all stop/pause events at any point during playback, TTS halts
   * immediately without waiting for translation.
   *
   * **Validates: Requirements 3.4, 3.5**
   */
  it('Property: Stop/pause responds immediately without waiting for translation', () => {
    fc.assert(
      fc.property(
        // Generate random chapter length (3–50 paragraphs, need enough to test mid-playback)
        fc.integer({ min: 3, max: 50 }),
        // Generate action: 'stop' or 'pause'
        fc.constantFrom('stop', 'pause'),
        (totalParagraphs, action) => {
          // Reset spoken texts
          spokenTexts.length = 0;

          // Build original panel
          const { originalPanel, translationPanel } = buildPanelsForOriginal(totalParagraphs, 0);

          document.body.innerHTML = '';
          document.body.appendChild(originalPanel);
          document.body.appendChild(translationPanel);

          // Create TTS controller
          const controller = new TTSController();
          controller.init({
            originalViewer: originalPanel,
            translationViewer: translationPanel,
            settings: { panel: 'original', mode: 'free' },
            onStateChange: () => {},
            onError: () => {}
          });

          // Start playback — this speaks the first paragraph and queues its onend timer
          controller.play();

          // The controller should now be in 'playing' state with the first paragraph spoken
          expect(controller.getState().status).toBe('playing');

          // Perform the stop/pause action WHILE the first paragraph is still "speaking"
          // (the onend timer hasn't fired yet because we haven't advanced timers)
          if (action === 'stop') {
            controller.stop();
            // Verify immediate synchronous state change to idle
            expect(controller.getState().status).toBe('idle');
          } else {
            controller.pause();
            // Verify immediate synchronous state change to paused
            expect(controller.getState().status).toBe('paused');
          }

          // Verify TTS did not continue to read more paragraphs
          // Only the first paragraph should have been passed to the speech engine
          expect(spokenTexts.length).toBe(1);

          // Clean up
          controller.destroy();
        }
      ),
      { numRuns: 50 }
    );
  });
});

// ---------------------------------------------------------------------------
// Helpers for Preservation Tests
// ---------------------------------------------------------------------------

/**
 * Mock SpeechSynthesis with SYNCHRONOUS onend dispatch via fake timers.
 * This allows us to drain speech events predictably in tests.
 */
function mockWebSpeechAPISync() {
  const spokenTexts = [];

  global.SpeechSynthesisUtterance = class {
    constructor(text) {
      this.text = text;
      this.voice = null;
      this.rate = 1.0;
      this.pitch = 1.0;
      this.onend = null;
      this.onerror = null;
    }
  };

  const mockSynth = {
    speaking: false,
    paused: false,
    getVoices: () => [{
      voiceURI: 'English (US)',
      lang: 'en-US',
      name: 'English US',
      localService: true
    }, {
      voiceURI: 'Italian (IT)',
      lang: 'it-IT',
      name: 'Italian IT',
      localService: true
    }],
    speak: (utterance) => {
      spokenTexts.push(utterance.text);
      mockSynth.speaking = true;
      // Use setTimeout(0) so vi.runAllTimers() can trigger onend
      setTimeout(() => {
        mockSynth.speaking = false;
        if (utterance.onend) utterance.onend();
      }, 0);
    },
    pause: () => { mockSynth.paused = true; mockSynth.speaking = false; },
    resume: () => { mockSynth.paused = false; mockSynth.speaking = true; },
    cancel: () => { mockSynth.speaking = false; mockSynth.paused = false; }
  };

  Object.defineProperty(window, 'speechSynthesis', {
    value: mockSynth,
    writable: true,
    configurable: true
  });

  return { spokenTexts, mockSynth };
}

/**
 * Build original panel with N paragraphs and a minimal translation panel.
 * Some paragraphs on the original panel may have 'pending' class (shouldn't affect original panel reading).
 */
function buildPanelsForOriginal(totalParagraphs, pendingOnOriginal) {
  const originalPanel = document.createElement('div');
  originalPanel.id = 'original-viewer';

  for (let i = 1; i <= totalParagraphs; i++) {
    const p = document.createElement('p');
    p.setAttribute('data-idx', String(i));
    p.textContent = `Original paragraph ${i}`;
    // Add 'pending' class to some paragraphs on original panel (shouldn't matter)
    if (i > totalParagraphs - pendingOnOriginal) {
      p.classList.add('pending');
    }
    originalPanel.appendChild(p);
  }

  const translationPanel = document.createElement('div');
  translationPanel.id = 'translation-viewer';

  return { originalPanel, translationPanel };
}

/**
 * Build translation panel with ALL paragraphs translated (no 'pending' class).
 */
function buildPanelsAllTranslated(totalParagraphs) {
  const originalPanel = document.createElement('div');
  originalPanel.id = 'original-viewer';

  const translationPanel = document.createElement('div');
  translationPanel.id = 'translation-viewer';

  for (let i = 1; i <= totalParagraphs; i++) {
    // Original panel
    const origP = document.createElement('p');
    origP.setAttribute('data-idx', String(i));
    origP.textContent = `Paragrafo originale ${i}`;
    originalPanel.appendChild(origP);

    // Translation panel — all translated, no 'pending' class
    const transP = document.createElement('p');
    transP.setAttribute('data-idx', String(i));
    transP.textContent = `Translated paragraph ${i}`;
    transP.setAttribute('data-translated', 'true');
    translationPanel.appendChild(transP);
  }

  return { originalPanel, translationPanel };
}

/**
 * Drain all speech events by running fake timers until TTS returns to idle
 * or we exceed a safety limit. Flushes microtasks between timer runs to handle
 * async _speakCurrent().
 */
async function drainAllSpeech(controller, maxIterations) {
  let iterations = 0;
  const limit = maxIterations + 10; // safety margin
  while (controller.getState().status === 'playing' && iterations < limit) {
    await vi.runAllTimersAsync();
    iterations++;
  }
}
