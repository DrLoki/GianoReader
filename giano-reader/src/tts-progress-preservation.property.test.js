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

// Mock fetch for PRO engine synthesis
vi.stubGlobal('fetch', vi.fn());

// Mock AudioContext for PRO engine
const mockAudioContext = {
  state: 'running',
  currentTime: 0,
  resume: vi.fn(() => Promise.resolve()),
  suspend: vi.fn(() => Promise.resolve()),
  destination: {},
  createBufferSource: vi.fn(() => ({
    buffer: null,
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    onended: null,
  })),
  createBuffer: vi.fn((channels, length, sampleRate) => ({
    getChannelData: () => new Float32Array(length),
    duration: length / sampleRate,
  })),
  decodeAudioData: vi.fn((arrayBuffer) => Promise.resolve({
    duration: 1.0,
    length: 44100,
    numberOfChannels: 1,
    sampleRate: 44100,
    getChannelData: () => new Float32Array(44100),
  })),
};

vi.stubGlobal('AudioContext', vi.fn(() => mockAudioContext));
vi.stubGlobal('webkitAudioContext', vi.fn(() => mockAudioContext));

import { TTSController, AudioBufferStore } from './tts.js';

/**
 * Creates a mock panel element with paragraph elements having data-idx attributes.
 * @param {number} paragraphCount - Number of paragraphs to create
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
 * Creates and initializes a TTSController with mock panels.
 * @param {number} originalCount - Number of paragraphs in original panel
 * @param {number} translationCount - Number of paragraphs in translation panel
 * @param {Object} [settingsOverride] - Additional settings
 * @returns {TTSController}
 */
function createController(originalCount, translationCount, settingsOverride = {}) {
  const controller = new TTSController();
  const originalViewer = createMockPanel(originalCount);
  const translationViewer = createMockPanel(translationCount);

  controller.init({
    originalViewer,
    translationViewer,
    settings: { mode: 'free', panel: 'original', rate: 1.0, pitch: 1.0, ...settingsOverride },
    onStateChange: () => {},
  });

  return controller;
}

/**
 * Advance the controller by triggering utterance-end N times.
 * @param {number} advanceCount
 */
function advanceByUtteranceEnd(advanceCount) {
  for (let i = 0; i < advanceCount; i++) {
    const utterance = mockUtterances[mockUtterances.length - 1];
    if (utterance && utterance.onend) {
      utterance.onend();
    }
  }
}

// Feature: tts-reading-progress-and-translation-trigger
// Property 2: Preservation - Download Buffer, Pause/Resume, and Panel Switch Unchanged
// **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6**

// P2a: AudioBufferStore.add() accumulates bytes and hasData() returns true
describe('P2a: AudioBufferStore accumulates bytes for download (preservation)', () => {
  beforeEach(() => {
    Object.keys(localStorageData).forEach(k => delete localStorageData[k]);
  });

  it('for all paragraph counts, add() stores bytes and hasData() returns true', () => {
    const paragraphCountArb = fc.integer({ min: 1, max: 50 });
    const addCountArb = fc.integer({ min: 1, max: 50 });

    fc.assert(
      fc.property(
        paragraphCountArb,
        addCountArb,
        (paragraphCount, addCount) => {
          const store = new AudioBufferStore();
          store.init(paragraphCount);

          const actualAdds = Math.min(addCount, paragraphCount);

          for (let i = 0; i < actualAdds; i++) {
            const bytes = new Uint8Array([0xFF, 0xFB, 0x90, i & 0xFF]);
            store.add(i, bytes);
          }

          // After adding, hasData() must return true
          expect(store.hasData()).toBe(true);

          // Store should contain exactly the added entries
          expect(store._store.size).toBe(actualAdds);

          // Each entry should be retrievable
          for (let i = 0; i < actualAdds; i++) {
            expect(store._store.has(i)).toBe(true);
          }

          store.clear();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('add() fires onProgress with floored percentage of synthesized/total', () => {
    const paragraphCountArb = fc.integer({ min: 1, max: 50 });
    const addSequenceArb = fc.integer({ min: 1, max: 50 });

    fc.assert(
      fc.property(
        paragraphCountArb,
        addSequenceArb,
        (paragraphCount, addCount) => {
          const progressValues = [];
          const store = new AudioBufferStore();
          store.init(paragraphCount, (pct) => {
            progressValues.push(pct);
          });

          const actualAdds = Math.min(addCount, paragraphCount);

          for (let i = 0; i < actualAdds; i++) {
            store.add(i, new Uint8Array([0xFF, 0xFB]));
          }

          // onProgress should have been called for each add
          expect(progressValues.length).toBe(actualAdds);

          // Each progress value should equal floor((storeSize / total) * 100)
          for (let i = 0; i < actualAdds; i++) {
            const expected = Math.floor(((i + 1) / paragraphCount) * 100);
            expect(progressValues[i]).toBe(expected);
          }

          store.clear();
        }
      ),
      { numRuns: 100 }
    );
  });
});

// P2b: pause() retains _currentIndex and play() resumes from same index
describe('P2b: Pause/resume preserves reading position (preservation)', () => {
  beforeEach(() => {
    mockUtterances.length = 0;
    mockSpeechSynthesis.speak.mockClear();
    mockSpeechSynthesis.pause.mockClear();
    mockSpeechSynthesis.resume.mockClear();
    mockSpeechSynthesis.cancel.mockClear();
    Object.keys(localStorageData).forEach(k => delete localStorageData[k]);
  });

  it('for all paragraph counts and advance counts, pause retains _currentIndex and play resumes from same index', () => {
    const paragraphCountArb = fc.integer({ min: 2, max: 50 });
    const advanceCountArb = fc.integer({ min: 0, max: 49 });

    fc.assert(
      fc.property(
        paragraphCountArb,
        advanceCountArb,
        (paragraphCount, advanceCount) => {
          const actualAdvance = Math.min(advanceCount, paragraphCount - 1);
          const controller = createController(paragraphCount, paragraphCount);

          // Start playback
          controller.play();
          expect(controller.getState().status).toBe('playing');

          // Advance to a random position
          advanceByUtteranceEnd(actualAdvance);
          expect(controller.getState().currentIndex).toBe(actualAdvance);

          // Pause - should retain the current index
          controller.pause();
          expect(controller.getState().status).toBe('paused');
          expect(controller.getState().currentIndex).toBe(actualAdvance);

          // The internal _currentIndex should be preserved
          expect(controller._currentIndex).toBe(actualAdvance);

          // Resume by calling play() - should resume from same index
          controller.play();
          expect(controller.getState().status).toBe('playing');
          expect(controller.getState().currentIndex).toBe(actualAdvance);
          expect(controller._currentIndex).toBe(actualAdvance);

          controller.destroy();
        }
      ),
      { numRuns: 100 }
    );
  });
});

// P2c: Panel switch during playback rebuilds queue and resumes at closest index
describe('P2c: Panel switch preserves position with clamping (preservation)', () => {
  beforeEach(() => {
    mockUtterances.length = 0;
    mockSpeechSynthesis.speak.mockClear();
    mockSpeechSynthesis.pause.mockClear();
    mockSpeechSynthesis.resume.mockClear();
    mockSpeechSynthesis.cancel.mockClear();
    Object.keys(localStorageData).forEach(k => delete localStorageData[k]);
  });

  it('for all paragraph counts and panel switches during playback, new queue index equals Math.min(previousIndex, newPanelLength - 1)', () => {
    const originalCountArb = fc.integer({ min: 2, max: 50 });
    const translationCountArb = fc.integer({ min: 1, max: 50 });
    const advanceCountArb = fc.integer({ min: 0, max: 49 });

    fc.assert(
      fc.property(
        originalCountArb,
        translationCountArb,
        advanceCountArb,
        (originalCount, translationCount, advanceCount) => {
          const actualAdvance = Math.min(advanceCount, originalCount - 1);
          const controller = createController(originalCount, translationCount);

          // Start playback on original panel
          controller.play();
          expect(controller.getState().status).toBe('playing');

          // Advance to a random position
          advanceByUtteranceEnd(actualAdvance);
          expect(controller.getState().currentIndex).toBe(actualAdvance);

          const previousIndex = controller._currentIndex;

          // Switch panel to translation
          controller.updateSettings({ panel: 'translation' });

          // The new index should be clamped: Math.min(previousIndex, newPanelLength - 1)
          const expectedIndex = Math.min(previousIndex, Math.max(0, translationCount - 1));
          expect(controller.getState().currentIndex).toBe(expectedIndex);
          expect(controller.getState().panel).toBe('translation');
          expect(controller.getState().status).toBe('playing');

          controller.destroy();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('switching back from translation to original also clamps correctly', () => {
    const originalCountArb = fc.integer({ min: 1, max: 50 });
    const translationCountArb = fc.integer({ min: 2, max: 50 });
    const advanceCountArb = fc.integer({ min: 0, max: 49 });

    fc.assert(
      fc.property(
        originalCountArb,
        translationCountArb,
        advanceCountArb,
        (originalCount, translationCount, advanceCount) => {
          // Start on translation panel
          const controller = createController(originalCount, translationCount, { panel: 'translation' });

          controller.play();
          const actualAdvance = Math.min(advanceCount, translationCount - 1);
          advanceByUtteranceEnd(actualAdvance);

          const previousIndex = controller._currentIndex;

          // Switch to original panel
          controller.updateSettings({ panel: 'original' });

          const expectedIndex = Math.min(previousIndex, Math.max(0, originalCount - 1));
          expect(controller.getState().currentIndex).toBe(expectedIndex);
          expect(controller.getState().panel).toBe('original');

          controller.destroy();
        }
      ),
      { numRuns: 100 }
    );
  });
});

// P2d: Original panel playback does not involve translation-related waiting
describe('P2d: Original panel playback has no translation involvement (preservation)', () => {
  beforeEach(() => {
    mockUtterances.length = 0;
    mockSpeechSynthesis.speak.mockClear();
    mockSpeechSynthesis.pause.mockClear();
    mockSpeechSynthesis.resume.mockClear();
    mockSpeechSynthesis.cancel.mockClear();
    Object.keys(localStorageData).forEach(k => delete localStorageData[k]);
  });

  it('for original panel playback with any paragraph count, _ensureTranslated is never called and _onTranslationNeeded is never invoked', () => {
    const paragraphCountArb = fc.integer({ min: 1, max: 50 });
    const advanceCountArb = fc.integer({ min: 0, max: 49 });

    fc.assert(
      fc.property(
        paragraphCountArb,
        advanceCountArb,
        (paragraphCount, advanceCount) => {
          const actualAdvance = Math.min(advanceCount, paragraphCount - 1);

          const onTranslationNeeded = vi.fn();
          const controller = new TTSController();
          const originalViewer = createMockPanel(paragraphCount);
          const translationViewer = createMockPanel(paragraphCount);

          controller.init({
            originalViewer,
            translationViewer,
            settings: { mode: 'free', panel: 'original', rate: 1.0, pitch: 1.0 },
            onStateChange: () => {},
            onTranslationNeeded,
          });

          // Spy on _ensureTranslated
          const ensureTranslatedSpy = vi.spyOn(controller, '_ensureTranslated');

          // Start playback on original panel
          controller.play();

          // Advance through paragraphs
          advanceByUtteranceEnd(actualAdvance);

          // _onTranslationNeeded should never be called for original panel
          expect(onTranslationNeeded).not.toHaveBeenCalled();

          // _ensureTranslated should never be called for original panel
          expect(ensureTranslatedSpy).not.toHaveBeenCalled();

          ensureTranslatedSpy.mockRestore();
          controller.destroy();
        }
      ),
      { numRuns: 100 }
    );
  });
});
