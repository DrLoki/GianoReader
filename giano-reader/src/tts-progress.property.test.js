import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';

// Mock speechSynthesis before importing tts.js
const mockUtterances = [];

const mockSpeechSynthesis = {
  speak: vi.fn((utterance) => {
    mockUtterances.push(utterance);
  }),
  pause: vi.fn(),
  resume: vi.fn(),
  cancel: vi.fn(() => {
    mockUtterances.length = 0;
  }),
  getVoices: vi.fn(() => [
    { voiceURI: 'English US', name: 'English US', lang: 'en-US', localService: true },
  ]),
};

vi.stubGlobal('speechSynthesis', mockSpeechSynthesis);
vi.stubGlobal('SpeechSynthesisUtterance', class MockUtterance {
  constructor(text) {
    this.text = text;
    this.voice = null;
    this.rate = 1;
    this.pitch = 1;
    this.onend = null;
    this.onerror = null;
  }
});

// Mock localStorage
const localStorageData = {};
vi.stubGlobal('localStorage', {
  getItem: vi.fn((key) => localStorageData[key] || null),
  setItem: vi.fn((key, value) => { localStorageData[key] = value; }),
  removeItem: vi.fn((key) => { delete localStorageData[key]; }),
  clear: vi.fn(() => { Object.keys(localStorageData).forEach(k => delete localStorageData[k]); }),
});

import { TTSController } from './tts.js';

/**
 * Creates a mock panel element with paragraph elements.
 * @param {number} paragraphCount
 * @returns {HTMLElement}
 */
function createMockPanel(paragraphCount) {
  const panel = document.createElement('div');
  for (let i = 0; i < paragraphCount; i++) {
    const p = document.createElement('p');
    p.setAttribute('data-idx', String(i));
    p.textContent = `Paragraph ${i} text content for testing`;
    p.scrollIntoView = vi.fn();
    panel.appendChild(p);
  }
  return panel;
}

/**
 * Creates a TTSController initialized for the given mode/model.
 * For PRO mode, stubs _speakPro as a no-op since PRO mode uses async fetch calls
 * (not SpeechSynthesis) that require a real API key. The test simulates paragraph
 * advancement manually via _advanceToNext(), which mirrors the real flow:
 * _speakPro completes audio playback → calls _advanceToNext().
 * @param {number} paragraphCount
 * @param {string} mode - 'free' or 'pro'
 * @param {string} model - TTS model name
 * @returns {{ controller: TTSController, progressCalls: number[] }}
 */
function createControllerWithProgress(paragraphCount, mode, model) {
  const controller = new TTSController();
  const originalViewer = createMockPanel(paragraphCount);
  const translationViewer = createMockPanel(paragraphCount);

  const progressCalls = [];

  controller.init({
    originalViewer,
    translationViewer,
    settings: { mode, panel: 'original', rate: 1.0, pitch: 1.0, ttsModel: model },
    onStateChange: () => {},
  });

  // For PRO mode: stub _speakPro as a no-op to prevent async fetch calls.
  // The test verifies progress fires from _speakCurrent() (which runs before _speakPro),
  // then simulates advancement manually via _advanceToNext().
  if (mode === 'pro') {
    controller._speakPro = vi.fn(); // no-op: prevents API calls and auto-advancement
  }

  // Wire up _onProgressChange to record calls
  controller._onProgressChange = (pct) => {
    progressCalls.push(pct);
  };

  return { controller, progressCalls };
}

// Feature: tts-reading-progress-and-translation-trigger
// Property 1: Bug Condition - Reading Progress Never Updates During TTS Playback
// **Validates: Requirements 1.1, 1.2, 1.3, 2.1, 2.1.1, 2.2, 2.2.1**
describe('Property 1: Bug Condition - Reading Progress Never Updates During TTS Playback', () => {
  beforeEach(() => {
    mockUtterances.length = 0;
    mockSpeechSynthesis.speak.mockClear();
    mockSpeechSynthesis.pause.mockClear();
    mockSpeechSynthesis.resume.mockClear();
    mockSpeechSynthesis.cancel.mockClear();
    Object.keys(localStorageData).forEach(k => delete localStorageData[k]);
  });

  it('_onProgressChange is called with correct reading-position percentage at each paragraph transition', () => {
    // Arbitraries matching the task specification
    const modeArb = fc.constantFrom('free', 'pro');
    const modelArb = fc.constantFrom('tts-1', 'gemini-2.5-flash');
    const paragraphCountArb = fc.integer({ min: 1, max: 50 });
    const advanceCountArb = fc.integer({ min: 0, max: 49 });

    fc.assert(
      fc.property(modeArb, modelArb, paragraphCountArb, advanceCountArb, (mode, model, paragraphCount, advanceCount) => {
        // Clamp advanceCount to valid range
        const maxAdvance = paragraphCount - 1;
        const actualAdvance = Math.min(advanceCount, maxAdvance);

        const { controller, progressCalls } = createControllerWithProgress(paragraphCount, mode, model);

        // Start playback (this calls _speakCurrent() for index 0)
        controller.play();

        // Neutralize AudioBufferStore's onProgress callback so we only capture
        // the reading-position progress calls from _speakCurrent/_advanceToNext,
        // not the download-buffer progress from AudioBufferStore.add/forceComplete.
        controller._bufferStore._onProgress = null;

        // Simulate paragraph advancement
        if (mode === 'free') {
          // In free mode, simulate utterance-end events to advance through paragraphs
          for (let i = 0; i < actualAdvance; i++) {
            const utterance = mockUtterances[mockUtterances.length - 1];
            if (utterance && utterance.onend) {
              utterance.onend();
            }
          }
        } else {
          // In pro mode, _speakPro is stubbed as a no-op (it normally uses async fetch).
          // Simulate the paragraph advancement that occurs after audio playback:
          // _speakPro finishes → calls _advanceToNext() → calls _speakCurrent() → fires progress.
          for (let i = 0; i < actualAdvance; i++) {
            controller._advanceToNext();
          }
        }

        // Assert: _onProgressChange was called for each paragraph transition
        // After play() + actualAdvance transitions, we should have (actualAdvance + 1) progress calls
        // (one for the initial play at index 0, plus one for each advance)
        const expectedCallCount = actualAdvance + 1;

        // Verify progress was fired at each paragraph transition
        expect(progressCalls.length).toBe(expectedCallCount);

        // Verify each call has the correct percentage value
        for (let i = 0; i <= actualAdvance; i++) {
          const expectedPct = Math.floor((i + 1) / paragraphCount * 100);
          expect(progressCalls[i]).toBe(expectedPct);
        }

        controller.destroy();
      }),
      { numRuns: 100 }
    );
  });

  it('#tts-progress element does not have the hidden class during playback', () => {
    // Create a #tts-progress element in the DOM
    const ttsProgress = document.createElement('span');
    ttsProgress.id = 'tts-progress';
    ttsProgress.classList.add('hidden'); // Start hidden (mirrors the bug state)
    document.body.appendChild(ttsProgress);

    const modeArb = fc.constantFrom('free', 'pro');
    const modelArb = fc.constantFrom('tts-1', 'gemini-2.5-flash');
    const paragraphCountArb = fc.integer({ min: 1, max: 50 });

    try {
      fc.assert(
        fc.property(modeArb, modelArb, paragraphCountArb, (mode, model, paragraphCount) => {
          const { controller, progressCalls } = createControllerWithProgress(paragraphCount, mode, model);

          // Wire up _onProgressChange to also update the DOM element (as main.js does)
          controller._onProgressChange = (pct) => {
            progressCalls.push(pct);
            ttsProgress.textContent = pct + '%';
            ttsProgress.classList.remove('hidden');
          };

          // Start playback
          controller.play();

          // Assert: during playback the element should not be hidden
          // The bug: _onProgressChange is never called from _speakCurrent(), so the
          // hidden class is never removed
          expect(ttsProgress.classList.contains('hidden')).toBe(false);

          // Assert: textContent should show the reading percentage
          const expectedPct = Math.floor(1 / paragraphCount * 100);
          expect(ttsProgress.textContent).toBe(expectedPct + '%');

          controller.destroy();

          // Reset for next iteration
          ttsProgress.classList.add('hidden');
          ttsProgress.textContent = '';
        }),
        { numRuns: 100 }
      );
    } finally {
      document.body.removeChild(ttsProgress);
    }
  });
});
