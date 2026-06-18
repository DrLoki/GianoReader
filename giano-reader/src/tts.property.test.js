import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';

// Mock speechSynthesis before importing tts.js
const mockUtterances = [];
let onEndCallback = null;

const mockSpeechSynthesis = {
  speak: vi.fn((utterance) => {
    mockUtterances.push(utterance);
    // Store the onend so we can trigger it manually
    onEndCallback = utterance.onend;
  }),
  pause: vi.fn(),
  resume: vi.fn(),
  cancel: vi.fn(() => {
    mockUtterances.length = 0;
    onEndCallback = null;
  }),
  getVoices: vi.fn(() => [
    { voiceURI: 'English US', name: 'English US', lang: 'en-US', localService: true },
    { voiceURI: 'Italian', name: 'Italian', lang: 'it-IT', localService: true },
  ]),
};

// Set up global mocks
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

import { TTSController, FreeTTSEngine, PositionTracker, LANG_TO_BCP47 } from './tts.js';

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
    p.textContent = `Paragraph ${i} text content`;
    // JSDOM doesn't implement scrollIntoView
    p.scrollIntoView = vi.fn();
    panel.appendChild(p);
  }
  return panel;
}

/**
 * Creates and initializes a TTSController with mock panels.
 * @param {number} paragraphCount - Number of paragraphs in each panel
 * @returns {TTSController}
 */
function createController(paragraphCount) {
  const controller = new TTSController();
  const originalViewer = createMockPanel(paragraphCount);
  const translationViewer = createMockPanel(paragraphCount);

  controller.init({
    originalViewer,
    translationViewer,
    settings: { mode: 'free', panel: 'original', rate: 1.0, pitch: 1.0 },
    onStateChange: () => {},
  });

  return controller;
}

// Feature: text-to-speech, Property 2: TTS settings persistence round-trip
// **Validates: Requirements 1.4, 8.4, 10.1, 10.2**
describe('Property 2: TTS settings persistence round-trip', () => {
  beforeEach(() => {
    Object.keys(localStorageData).forEach(k => delete localStorageData[k]);
  });

  it('serializing TTS settings to localStorage and deserializing produces equivalent settings', () => {
    const modeArb = fc.constantFrom('free', 'pro');
    const voiceURIArb = fc.string({ minLength: 1, maxLength: 50 });
    const ttsModelArb = fc.string({ minLength: 1, maxLength: 50 });
    const rateArb = fc.double({ min: 0.5, max: 2.0, noNaN: true, noDefaultInfinity: true });
    const pitchArb = fc.double({ min: 0.5, max: 2.0, noNaN: true, noDefaultInfinity: true });
    const panelArb = fc.constantFrom('original', 'translation');
    // ttsVoice must be non-empty; the code treats empty string as "use default" via || 'alloy'
    const ttsVoiceArb = fc.string({ minLength: 1, maxLength: 50 });

    const settingsArb = fc.record({
      mode: modeArb,
      voiceURI: voiceURIArb,
      ttsModel: ttsModelArb,
      rate: rateArb,
      pitch: pitchArb,
      panel: panelArb,
      ttsVoice: ttsVoiceArb,
    });

    fc.assert(
      fc.property(settingsArb, (settings) => {
        // Clear localStorage before each iteration
        Object.keys(localStorageData).forEach(k => delete localStorageData[k]);

        // Create a controller and save settings via updateSettings
        const controller1 = new TTSController();
        controller1.init({
          originalViewer: createMockPanel(1),
          translationViewer: createMockPanel(1),
          onStateChange: () => {},
        });
        controller1.updateSettings(settings);

        // Create a new controller and restore settings via init
        const controller2 = new TTSController();
        controller2.init({
          originalViewer: createMockPanel(1),
          translationViewer: createMockPanel(1),
          onStateChange: () => {},
        });

        // Verify all settings are preserved after the round-trip
        const state2 = controller2.getState();
        expect(state2.panel).toBe(settings.panel);

        // Access internal settings for full verification
        expect(controller2._settings.mode).toBe(settings.mode);
        expect(controller2._settings.voiceURI).toBe(settings.voiceURI);
        expect(controller2._settings.ttsModel).toBe(settings.ttsModel);
        expect(controller2._settings.rate).toBeCloseTo(settings.rate, 10);
        expect(controller2._settings.pitch).toBeCloseTo(settings.pitch, 10);
        expect(controller2._settings.panel).toBe(settings.panel);
        expect(controller2._settings.ttsVoice).toBe(settings.ttsVoice);

        controller1.destroy();
        controller2.destroy();
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: text-to-speech, Property 5: State machine transitions are consistent
// **Validates: Requirements 4.2, 4.3, 4.4, 4.5, 4.6, 2.5**
describe('Property 5: State machine transitions are consistent', () => {
  beforeEach(() => {
    mockUtterances.length = 0;
    onEndCallback = null;
    mockSpeechSynthesis.speak.mockClear();
    mockSpeechSynthesis.pause.mockClear();
    mockSpeechSynthesis.resume.mockClear();
    mockSpeechSynthesis.cancel.mockClear();
    Object.keys(localStorageData).forEach(k => delete localStorageData[k]);
  });

  it('idle + play = playing', () => {
    // Generate random paragraph counts to verify the transition holds for any content
    const paragraphCountArb = fc.integer({ min: 1, max: 20 });

    fc.assert(
      fc.property(paragraphCountArb, (paragraphCount) => {
        const controller = createController(paragraphCount);

        expect(controller.getState().status).toBe('idle');
        controller.play();
        expect(controller.getState().status).toBe('playing');

        controller.destroy();
      }),
      { numRuns: 100 }
    );
  });

  it('playing + pause = paused', () => {
    const paragraphCountArb = fc.integer({ min: 1, max: 20 });

    fc.assert(
      fc.property(paragraphCountArb, (paragraphCount) => {
        const controller = createController(paragraphCount);

        controller.play();
        expect(controller.getState().status).toBe('playing');

        controller.pause();
        expect(controller.getState().status).toBe('paused');

        controller.destroy();
      }),
      { numRuns: 100 }
    );
  });

  it('paused + play = playing (resume)', () => {
    const paragraphCountArb = fc.integer({ min: 1, max: 20 });

    fc.assert(
      fc.property(paragraphCountArb, (paragraphCount) => {
        const controller = createController(paragraphCount);

        controller.play();
        controller.pause();
        expect(controller.getState().status).toBe('paused');

        controller.play();
        expect(controller.getState().status).toBe('playing');

        controller.destroy();
      }),
      { numRuns: 100 }
    );
  });

  it('playing + stop = idle', () => {
    const paragraphCountArb = fc.integer({ min: 1, max: 20 });

    fc.assert(
      fc.property(paragraphCountArb, (paragraphCount) => {
        const controller = createController(paragraphCount);

        controller.play();
        expect(controller.getState().status).toBe('playing');

        controller.stop();
        expect(controller.getState().status).toBe('idle');

        controller.destroy();
      }),
      { numRuns: 100 }
    );
  });

  it('paused + stop = idle', () => {
    const paragraphCountArb = fc.integer({ min: 1, max: 20 });

    fc.assert(
      fc.property(paragraphCountArb, (paragraphCount) => {
        const controller = createController(paragraphCount);

        controller.play();
        controller.pause();
        expect(controller.getState().status).toBe('paused');

        controller.stop();
        expect(controller.getState().status).toBe('idle');

        controller.destroy();
      }),
      { numRuns: 100 }
    );
  });

  it('playing + utterance-end at last paragraph = idle', () => {
    // Use exactly 1 paragraph so the first utterance-end is the last
    const controller = createController(1);

    controller.play();
    expect(controller.getState().status).toBe('playing');

    // Simulate utterance end (the FreeTTSEngine calls onEnd which triggers _advanceToNext)
    const utterance = mockUtterances[mockUtterances.length - 1];
    if (utterance && utterance.onend) {
      utterance.onend();
    }

    expect(controller.getState().status).toBe('idle');
    controller.destroy();
  });

  it('playing + utterance-end not at last = playing at next index', () => {
    const paragraphCountArb = fc.integer({ min: 2, max: 20 });

    fc.assert(
      fc.property(paragraphCountArb, (paragraphCount) => {
        const controller = createController(paragraphCount);

        controller.play();
        expect(controller.getState().status).toBe('playing');
        expect(controller.getState().currentIndex).toBe(0);

        // Simulate utterance end for the first paragraph (not the last)
        const utterance = mockUtterances[mockUtterances.length - 1];
        if (utterance && utterance.onend) {
          utterance.onend();
        }

        expect(controller.getState().status).toBe('playing');
        expect(controller.getState().currentIndex).toBe(1);

        controller.destroy();
      }),
      { numRuns: 100 }
    );
  });

  it('random action sequences produce consistent state transitions', () => {
    // Generate random sequences of actions and verify the state machine is consistent
    const actionArb = fc.constantFrom('play', 'pause', 'stop', 'utterance-end');
    const actionSequenceArb = fc.array(actionArb, { minLength: 1, maxLength: 30 });
    const paragraphCountArb = fc.integer({ min: 2, max: 10 });

    fc.assert(
      fc.property(paragraphCountArb, actionSequenceArb, (paragraphCount, actions) => {
        const controller = createController(paragraphCount);

        for (const action of actions) {
          const stateBefore = controller.getState().status;
          const indexBefore = controller.getState().currentIndex;

          switch (action) {
            case 'play':
              controller.play();
              if (stateBefore === 'idle') {
                expect(controller.getState().status).toBe('playing');
              } else if (stateBefore === 'paused') {
                expect(controller.getState().status).toBe('playing');
              } else {
                // Already playing — state should remain playing
                expect(controller.getState().status).toBe('playing');
              }
              break;

            case 'pause':
              controller.pause();
              if (stateBefore === 'playing') {
                expect(controller.getState().status).toBe('paused');
              } else {
                // Pause from idle or paused is a no-op
                expect(controller.getState().status).toBe(stateBefore);
              }
              break;

            case 'stop':
              controller.stop();
              if (stateBefore === 'idle') {
                // Stop from idle is a no-op
                expect(controller.getState().status).toBe('idle');
              } else {
                expect(controller.getState().status).toBe('idle');
              }
              break;

            case 'utterance-end':
              // Only meaningful when playing
              if (stateBefore === 'playing') {
                const utterance = mockUtterances[mockUtterances.length - 1];
                if (utterance && utterance.onend) {
                  utterance.onend();
                }
                // After utterance-end: either still playing (next paragraph) or idle (was last)
                const stateAfter = controller.getState().status;
                expect(['playing', 'idle']).toContain(stateAfter);

                if (stateAfter === 'playing') {
                  // Index should have advanced
                  expect(controller.getState().currentIndex).toBe(indexBefore + 1);
                } else {
                  // Reached the end — back to idle
                  expect(stateAfter).toBe('idle');
                }
              }
              break;
          }
        }

        controller.destroy();
      }),
      { numRuns: 100 }
    );
  });

  it('no-op transitions: pause from idle stays idle, pause from paused stays paused', () => {
    const paragraphCountArb = fc.integer({ min: 1, max: 20 });

    fc.assert(
      fc.property(paragraphCountArb, (paragraphCount) => {
        const controller = createController(paragraphCount);

        // Pause from idle is a no-op
        expect(controller.getState().status).toBe('idle');
        controller.pause();
        expect(controller.getState().status).toBe('idle');

        // Get to paused state
        controller.play();
        controller.pause();
        expect(controller.getState().status).toBe('paused');

        // Pause from paused is a no-op
        controller.pause();
        expect(controller.getState().status).toBe('paused');

        controller.destroy();
      }),
      { numRuns: 100 }
    );
  });

  it('stop from idle is a no-op', () => {
    const paragraphCountArb = fc.integer({ min: 1, max: 20 });

    fc.assert(
      fc.property(paragraphCountArb, (paragraphCount) => {
        const controller = createController(paragraphCount);

        expect(controller.getState().status).toBe('idle');
        controller.stop();
        expect(controller.getState().status).toBe('idle');

        controller.destroy();
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: text-to-speech, Property 7: Panel switch restarts at current position
// **Validates: Requirements 6.4**
describe('Property 7: Panel switch restarts at current position', () => {
  beforeEach(() => {
    mockUtterances.length = 0;
    onEndCallback = null;
    mockSpeechSynthesis.speak.mockClear();
    mockSpeechSynthesis.pause.mockClear();
    mockSpeechSynthesis.resume.mockClear();
    mockSpeechSynthesis.cancel.mockClear();
    Object.keys(localStorageData).forEach(k => delete localStorageData[k]);
  });

  /**
   * Creates a TTSController with different paragraph counts for each panel.
   * @param {number} originalCount - Number of paragraphs in the original panel
   * @param {number} translationCount - Number of paragraphs in the translation panel
   * @returns {TTSController}
   */
  function createControllerWithPanels(originalCount, translationCount) {
    const controller = new TTSController();
    const originalViewer = createMockPanel(originalCount);
    const translationViewer = createMockPanel(translationCount);

    controller.init({
      originalViewer,
      translationViewer,
      settings: { mode: 'free', panel: 'original', rate: 1.0, pitch: 1.0 },
      onStateChange: () => {},
    });

    return controller;
  }

  /**
   * Advance the controller to a given index by simulating utterance-end events.
   * @param {number} advanceCount - Number of times to trigger utterance-end
   */
  function advanceToIndex(advanceCount) {
    for (let i = 0; i < advanceCount; i++) {
      const utterance = mockUtterances[mockUtterances.length - 1];
      if (utterance && utterance.onend) {
        utterance.onend();
      }
    }
  }

  it('switching panel while playing restarts at the same index', () => {
    const paragraphCountArb = fc.integer({ min: 2, max: 20 });
    const advanceArb = fc.integer({ min: 0, max: 19 });

    fc.assert(
      fc.property(
        paragraphCountArb,
        advanceArb,
        (paragraphCount, advanceCount) => {
          // Clamp advanceCount so we don't go past the end
          const maxAdvance = paragraphCount - 1;
          const actualAdvance = Math.min(advanceCount, maxAdvance);

          const controller = createControllerWithPanels(paragraphCount, paragraphCount);

          // Start playback on original panel
          controller.play();
          expect(controller.getState().status).toBe('playing');
          expect(controller.getState().currentIndex).toBe(0);

          // Advance to a random index
          advanceToIndex(actualAdvance);
          expect(controller.getState().currentIndex).toBe(actualAdvance);
          expect(controller.getState().status).toBe('playing');

          // Switch panel to translation
          controller.updateSettings({ panel: 'translation' });

          // Verify: state is playing and currentIndex equals the saved index
          expect(controller.getState().status).toBe('playing');
          expect(controller.getState().currentIndex).toBe(actualAdvance);
          expect(controller.getState().panel).toBe('translation');

          controller.destroy();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('switching panel while paused restarts at the same index (in playing state)', () => {
    const paragraphCountArb = fc.integer({ min: 2, max: 20 });
    const advanceArb = fc.integer({ min: 0, max: 19 });

    fc.assert(
      fc.property(
        paragraphCountArb,
        advanceArb,
        (paragraphCount, advanceCount) => {
          const maxAdvance = paragraphCount - 1;
          const actualAdvance = Math.min(advanceCount, maxAdvance);

          const controller = createControllerWithPanels(paragraphCount, paragraphCount);

          // Start playback and advance
          controller.play();
          advanceToIndex(actualAdvance);
          expect(controller.getState().currentIndex).toBe(actualAdvance);

          // Pause
          controller.pause();
          expect(controller.getState().status).toBe('paused');

          // Switch panel to translation
          controller.updateSettings({ panel: 'translation' });

          // Verify: state is playing (restarts) and currentIndex equals the saved index
          expect(controller.getState().status).toBe('playing');
          expect(controller.getState().currentIndex).toBe(actualAdvance);
          expect(controller.getState().panel).toBe('translation');

          controller.destroy();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('switching panel clamps index when new panel is shorter', () => {
    const originalCountArb = fc.integer({ min: 5, max: 20 });
    const translationCountArb = fc.integer({ min: 1, max: 4 });
    const advanceArb = fc.integer({ min: 0, max: 19 });

    fc.assert(
      fc.property(
        originalCountArb,
        translationCountArb,
        advanceArb,
        (originalCount, translationCount, advanceCount) => {
          // Ensure we advance beyond what the translation panel has
          const maxAdvance = originalCount - 1;
          const actualAdvance = Math.min(advanceCount, maxAdvance);

          const controller = createControllerWithPanels(originalCount, translationCount);

          // Start playback and advance
          controller.play();
          advanceToIndex(actualAdvance);
          expect(controller.getState().currentIndex).toBe(actualAdvance);

          // Switch panel to translation (which is shorter)
          controller.updateSettings({ panel: 'translation' });

          // Verify: index is clamped to the new panel's max index
          const expectedIndex = Math.min(actualAdvance, translationCount - 1);
          expect(controller.getState().status).toBe('playing');
          expect(controller.getState().currentIndex).toBe(expectedIndex);
          expect(controller.getState().panel).toBe('translation');

          controller.destroy();
        }
      ),
      { numRuns: 100 }
    );
  });
});

// Feature: text-to-speech, Property 8: Rate and pitch changes apply to the next utterance
// **Validates: Requirements 8.3**
describe('Property 8: Rate and pitch changes apply to the next utterance', () => {
  beforeEach(() => {
    mockUtterances.length = 0;
    onEndCallback = null;
    mockSpeechSynthesis.speak.mockClear();
    mockSpeechSynthesis.pause.mockClear();
    mockSpeechSynthesis.resume.mockClear();
    mockSpeechSynthesis.cancel.mockClear();
    Object.keys(localStorageData).forEach(k => delete localStorageData[k]);
  });

  it('changing rate and pitch during playback does not affect the current utterance but applies to subsequent ones', () => {
    const rateArb = fc.double({ min: 0.5, max: 2.0, noNaN: true, noDefaultInfinity: true });
    const pitchArb = fc.double({ min: 0.5, max: 2.0, noNaN: true, noDefaultInfinity: true });

    fc.assert(
      fc.property(rateArb, pitchArb, (newRate, newPitch) => {
        // Reset mocks for each iteration
        mockUtterances.length = 0;
        onEndCallback = null;
        mockSpeechSynthesis.speak.mockClear();
        mockSpeechSynthesis.cancel.mockClear();
        Object.keys(localStorageData).forEach(k => delete localStorageData[k]);

        // Create a controller with at least 2 paragraphs so we can advance
        const controller = createController(3);

        // Start playback — first utterance is created with initial rate=1.0, pitch=1.0
        controller.play();
        expect(controller.getState().status).toBe('playing');
        expect(mockUtterances.length).toBeGreaterThanOrEqual(1);

        const firstUtterance = mockUtterances[mockUtterances.length - 1];
        const originalRate = firstUtterance.rate;
        const originalPitch = firstUtterance.pitch;

        // The first utterance should have the initial defaults (1.0)
        expect(originalRate).toBe(1.0);
        expect(originalPitch).toBe(1.0);

        // Change rate and pitch during playback
        controller.updateSettings({ rate: newRate, pitch: newPitch });

        // The currently speaking utterance should NOT be affected
        expect(firstUtterance.rate).toBe(originalRate);
        expect(firstUtterance.pitch).toBe(originalPitch);

        // Simulate utterance end to advance to the next paragraph
        if (firstUtterance.onend) {
          firstUtterance.onend();
        }

        // The controller should still be playing (we have more paragraphs)
        expect(controller.getState().status).toBe('playing');

        // The new utterance should have the updated rate and pitch
        const secondUtterance = mockUtterances[mockUtterances.length - 1];
        expect(secondUtterance.rate).toBeCloseTo(newRate, 10);
        expect(secondUtterance.pitch).toBeCloseTo(newPitch, 10);

        controller.destroy();
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: text-to-speech, Property 3: Voice matching filters by BCP-47 language prefix
// **Validates: Requirements 2.2, 7.2**
describe('Property 3: Voice matching filters by BCP-47 language prefix', () => {
  /**
   * Arbitrary that generates a mock SpeechSynthesisVoice object with a random lang code.
   * Lang codes are drawn from a mix of:
   * - Known BCP-47 codes from LANG_TO_BCP47 values (e.g., 'it-IT', 'en-US')
   * - Just the language part (e.g., 'it', 'en')
   * - Extended subtags (e.g., 'it-IT-extra')
   * - Different regions (e.g., 'it-CH', 'en-GB')
   * - Completely unrelated codes (e.g., 'xx-YY')
   */
  const bcp47Values = Object.values(LANG_TO_BCP47);
  const langKeys = Object.keys(LANG_TO_BCP47);

  const voiceLangArb = fc.oneof(
    // Exact BCP-47 prefix from the map (e.g., 'it-IT', 'en-US')
    fc.constantFrom(...bcp47Values),
    // Just the language part (e.g., 'it', 'en')
    fc.constantFrom(...langKeys),
    // Extended subtag (e.g., 'it-IT-extra')
    fc.constantFrom(...bcp47Values).map(v => `${v}-extra`),
    // Different region (e.g., 'it-CH', 'en-GB') - should NOT match
    fc.constantFrom(...langKeys).chain(lang =>
      fc.constantFrom('CH', 'GB', 'AU', 'MX', 'BR', 'CA').map(region => `${lang}-${region}`)
    ),
    // Completely unrelated codes
    fc.constantFrom('xx-YY', 'zz-WW', 'qq-RR', 'nn-NN')
  );

  const mockVoiceArb = voiceLangArb.map(lang => ({
    voiceURI: `voice-${lang}`,
    name: `Voice ${lang}`,
    lang,
    localService: true,
    default: false,
  }));

  const voiceListArb = fc.array(mockVoiceArb, { minLength: 0, maxLength: 30 });
  const targetLangArb = fc.constantFrom(...langKeys);

  it('all returned voices match the BCP-47 prefix for the target language', () => {
    fc.assert(
      fc.property(voiceListArb, targetLangArb, (voices, targetLang) => {
        // Set up a FreeTTSEngine with mocked _synth
        const engine = new FreeTTSEngine();
        engine._synth = { getVoices: () => voices };

        const result = engine.getVoicesForLang(targetLang);
        const bcp47Prefix = LANG_TO_BCP47[targetLang].toLowerCase(); // e.g. 'it-it'
        const langPart = bcp47Prefix.split('-')[0]; // e.g. 'it'

        // All returned voices must match the expected pattern
        for (const voice of result) {
          const voiceLang = voice.lang.toLowerCase();
          const matchesFullPrefix = voiceLang === bcp47Prefix || voiceLang.startsWith(bcp47Prefix + '-');
          const matchesLangPart = voiceLang === langPart;
          expect(matchesFullPrefix || matchesLangPart).toBe(true);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('no matching voices are excluded from the result', () => {
    fc.assert(
      fc.property(voiceListArb, targetLangArb, (voices, targetLang) => {
        // Set up a FreeTTSEngine with mocked _synth
        const engine = new FreeTTSEngine();
        engine._synth = { getVoices: () => voices };

        const result = engine.getVoicesForLang(targetLang);
        const bcp47Prefix = LANG_TO_BCP47[targetLang].toLowerCase();
        const langPart = bcp47Prefix.split('-')[0];

        // Compute the expected set of matching voices
        const expectedMatches = voices.filter(v => {
          const voiceLang = v.lang.toLowerCase();
          if (voiceLang === bcp47Prefix || voiceLang.startsWith(bcp47Prefix + '-')) return true;
          if (voiceLang === langPart) return true;
          return false;
        });

        // The result should contain exactly the expected matches (no exclusions)
        expect(result.length).toBe(expectedMatches.length);

        // Every expected match should be in the result
        for (const expected of expectedMatches) {
          expect(result).toContain(expected);
        }
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: text-to-speech, Property 6: Highlight tracks the currently speaking paragraph
// **Validates: Requirements 5.1, 5.2, 5.4**
describe('Property 6: Highlight tracks the currently speaking paragraph', () => {
  beforeEach(() => {
    mockUtterances.length = 0;
    onEndCallback = null;
    mockSpeechSynthesis.speak.mockClear();
    mockSpeechSynthesis.pause.mockClear();
    mockSpeechSynthesis.resume.mockClear();
    mockSpeechSynthesis.cancel.mockClear();
    Object.keys(localStorageData).forEach(k => delete localStorageData[k]);
  });

  it('highlight(panel, index) sets exactly one element with .tts-speaking class', () => {
    const paragraphCountArb = fc.integer({ min: 1, max: 30 });

    fc.assert(
      fc.property(paragraphCountArb, (paragraphCount) => {
        const tracker = new PositionTracker();
        const panel = createMockPanel(paragraphCount);

        // Pick a random valid index
        const index = Math.floor(Math.random() * paragraphCount);
        tracker.highlight(panel, index);

        // Exactly one element should have the class
        const highlighted = panel.querySelectorAll('.tts-speaking');
        expect(highlighted.length).toBe(1);

        // That element should be the one at the target index
        expect(highlighted[0].getAttribute('data-idx')).toBe(String(index));
      }),
      { numRuns: 100 }
    );
  });

  it('highlight(panel, newIndex) removes class from old element and adds to new element', () => {
    const paragraphCountArb = fc.integer({ min: 2, max: 30 });

    fc.assert(
      fc.property(
        paragraphCountArb.chain(count => {
          // Generate two distinct indices
          return fc.tuple(
            fc.constant(count),
            fc.integer({ min: 0, max: count - 1 }),
            fc.integer({ min: 0, max: count - 1 })
          ).filter(([, i, j]) => i !== j);
        }),
        ([paragraphCount, oldIndex, newIndex]) => {
          const tracker = new PositionTracker();
          const panel = createMockPanel(paragraphCount);

          // Highlight old index first
          tracker.highlight(panel, oldIndex);
          const oldEl = panel.querySelector(`[data-idx="${oldIndex}"]`);
          expect(oldEl.classList.contains('tts-speaking')).toBe(true);

          // Now highlight new index
          tracker.highlight(panel, newIndex);

          // Old element should NOT have the class
          expect(oldEl.classList.contains('tts-speaking')).toBe(false);

          // New element should have the class
          const newEl = panel.querySelector(`[data-idx="${newIndex}"]`);
          expect(newEl.classList.contains('tts-speaking')).toBe(true);

          // Exactly one element should have the class
          const highlighted = panel.querySelectorAll('.tts-speaking');
          expect(highlighted.length).toBe(1);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('clear(panel) removes .tts-speaking from all elements', () => {
    const paragraphCountArb = fc.integer({ min: 1, max: 30 });
    const indexSequenceArb = paragraphCountArb.chain(count =>
      fc.tuple(
        fc.constant(count),
        fc.array(fc.integer({ min: 0, max: count - 1 }), { minLength: 1, maxLength: 10 })
      )
    );

    fc.assert(
      fc.property(indexSequenceArb, ([paragraphCount, indices]) => {
        const tracker = new PositionTracker();
        const panel = createMockPanel(paragraphCount);

        // Apply a sequence of highlights
        for (const idx of indices) {
          tracker.highlight(panel, idx);
        }

        // Clear all highlights
        tracker.clear(panel);

        // No elements should have the class
        const highlighted = panel.querySelectorAll('.tts-speaking');
        expect(highlighted.length).toBe(0);
      }),
      { numRuns: 100 }
    );
  });

  it('TTSController: starting playback highlights the first paragraph', () => {
    const paragraphCountArb = fc.integer({ min: 1, max: 20 });

    fc.assert(
      fc.property(paragraphCountArb, (paragraphCount) => {
        const controller = createController(paragraphCount);
        const panel = controller._originalViewer;

        controller.play();

        // The first paragraph (data-idx="0") should be highlighted
        const highlighted = panel.querySelectorAll('.tts-speaking');
        expect(highlighted.length).toBe(1);
        expect(highlighted[0].getAttribute('data-idx')).toBe('0');

        controller.destroy();
      }),
      { numRuns: 100 }
    );
  });

  it('TTSController: utterance end moves highlight to next paragraph', () => {
    const paragraphCountArb = fc.integer({ min: 2, max: 20 });

    fc.assert(
      fc.property(paragraphCountArb, (paragraphCount) => {
        const controller = createController(paragraphCount);
        const panel = controller._originalViewer;

        controller.play();

        // First paragraph should be highlighted
        expect(panel.querySelector('[data-idx="0"]').classList.contains('tts-speaking')).toBe(true);

        // Simulate utterance end — triggers advance to next paragraph
        const utterance = mockUtterances[mockUtterances.length - 1];
        if (utterance && utterance.onend) {
          utterance.onend();
        }

        // Now second paragraph should be highlighted, first should not
        expect(panel.querySelector('[data-idx="0"]').classList.contains('tts-speaking')).toBe(false);
        expect(panel.querySelector('[data-idx="1"]').classList.contains('tts-speaking')).toBe(true);

        // Exactly one element highlighted
        const highlighted = panel.querySelectorAll('.tts-speaking');
        expect(highlighted.length).toBe(1);

        controller.destroy();
      }),
      { numRuns: 100 }
    );
  });

  it('TTSController: stopping playback removes all highlights', () => {
    const paragraphCountArb = fc.integer({ min: 1, max: 20 });

    fc.assert(
      fc.property(paragraphCountArb, (paragraphCount) => {
        const controller = createController(paragraphCount);
        const panel = controller._originalViewer;

        controller.play();

        // Verify something is highlighted
        expect(panel.querySelectorAll('.tts-speaking').length).toBe(1);

        // Stop playback
        controller.stop();

        // No highlights should remain
        const highlighted = panel.querySelectorAll('.tts-speaking');
        expect(highlighted.length).toBe(0);

        controller.destroy();
      }),
      { numRuns: 100 }
    );
  });

  it('random index sequences always maintain exactly one highlight', () => {
    const paragraphCountArb = fc.integer({ min: 2, max: 30 });
    const indexSequenceArb = paragraphCountArb.chain(count =>
      fc.tuple(
        fc.constant(count),
        fc.array(fc.integer({ min: 0, max: count - 1 }), { minLength: 2, maxLength: 20 })
      )
    );

    fc.assert(
      fc.property(indexSequenceArb, ([paragraphCount, indices]) => {
        const tracker = new PositionTracker();
        const panel = createMockPanel(paragraphCount);

        for (const idx of indices) {
          tracker.highlight(panel, idx);

          // After each highlight call, exactly one element should have the class
          const highlighted = panel.querySelectorAll('.tts-speaking');
          expect(highlighted.length).toBe(1);
          expect(highlighted[0].getAttribute('data-idx')).toBe(String(idx));
        }
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: text-to-speech, Property 9: External navigation events stop active playback
// **Validates: Requirements 9.1, 9.2, 9.3**
describe('Property 9: External navigation events stop active playback', () => {
  beforeEach(() => {
    mockUtterances.length = 0;
    onEndCallback = null;
    mockSpeechSynthesis.speak.mockClear();
    mockSpeechSynthesis.pause.mockClear();
    mockSpeechSynthesis.resume.mockClear();
    mockSpeechSynthesis.cancel.mockClear();
    Object.keys(localStorageData).forEach(k => delete localStorageData[k]);
  });

  it('stop() from playing state transitions to idle with position reset to 0', () => {
    const paragraphCountArb = fc.integer({ min: 2, max: 50 });
    const advanceCountArb = fc.integer({ min: 0, max: 20 });

    fc.assert(
      fc.property(paragraphCountArb, advanceCountArb, (paragraphCount, advanceCount) => {
        const controller = createController(paragraphCount);

        // Start playback
        controller.play();
        expect(controller.getState().status).toBe('playing');

        // Advance to a random position by simulating utterance-end events
        const actualAdvances = Math.min(advanceCount, paragraphCount - 1);
        for (let i = 0; i < actualAdvances; i++) {
          const utterance = mockUtterances[mockUtterances.length - 1];
          if (utterance && utterance.onend) {
            utterance.onend();
          }
          // If we reached idle (last paragraph), break
          if (controller.getState().status === 'idle') break;
        }

        // Only test stop if we're still in an active state
        if (controller.getState().status === 'playing') {
          // Simulate external navigation event by calling stop()
          controller.stop();

          // Verify: state is idle and currentIndex is 0
          expect(controller.getState().status).toBe('idle');
          expect(controller.getState().currentIndex).toBe(0);
        }

        controller.destroy();
      }),
      { numRuns: 100 }
    );
  });

  it('stop() from paused state transitions to idle with position reset to 0', () => {
    const paragraphCountArb = fc.integer({ min: 2, max: 50 });
    const advanceCountArb = fc.integer({ min: 0, max: 20 });

    fc.assert(
      fc.property(paragraphCountArb, advanceCountArb, (paragraphCount, advanceCount) => {
        const controller = createController(paragraphCount);

        // Start playback
        controller.play();
        expect(controller.getState().status).toBe('playing');

        // Advance to a random position
        const actualAdvances = Math.min(advanceCount, paragraphCount - 1);
        for (let i = 0; i < actualAdvances; i++) {
          const utterance = mockUtterances[mockUtterances.length - 1];
          if (utterance && utterance.onend) {
            utterance.onend();
          }
          if (controller.getState().status === 'idle') break;
        }

        // Only test if still playing (not already finished)
        if (controller.getState().status === 'playing') {
          // Pause playback
          controller.pause();
          expect(controller.getState().status).toBe('paused');

          // Simulate external navigation event by calling stop()
          controller.stop();

          // Verify: state is idle and currentIndex is 0
          expect(controller.getState().status).toBe('idle');
          expect(controller.getState().currentIndex).toBe(0);
        }

        controller.destroy();
      }),
      { numRuns: 100 }
    );
  });

  it('stop() resets position to 0 regardless of how far playback has advanced', () => {
    // Test with various paragraph counts and advance positions to ensure
    // the position is always reset to 0 on stop (simulating chapter nav, book close, lang change)
    const paragraphCountArb = fc.integer({ min: 1, max: 100 });
    const advanceCountArb = fc.integer({ min: 0, max: 50 });
    const stateArb = fc.constantFrom('playing', 'paused');

    fc.assert(
      fc.property(paragraphCountArb, advanceCountArb, stateArb, (paragraphCount, advanceCount, targetState) => {
        const controller = createController(paragraphCount);

        // Start playback
        controller.play();

        // Advance to a random position
        const maxAdvances = Math.min(advanceCount, paragraphCount - 1);
        for (let i = 0; i < maxAdvances; i++) {
          const utterance = mockUtterances[mockUtterances.length - 1];
          if (utterance && utterance.onend) {
            utterance.onend();
          }
          if (controller.getState().status === 'idle') break;
        }

        // If we're still active, put into the target state and stop
        if (controller.getState().status === 'playing') {
          if (targetState === 'paused') {
            controller.pause();
          }

          // Call stop (simulating what main.js does on navigation/close/language change)
          controller.stop();

          // Verify: state is idle and currentIndex is 0
          expect(controller.getState().status).toBe('idle');
          expect(controller.getState().currentIndex).toBe(0);
        }

        controller.destroy();
      }),
      { numRuns: 100 }
    );
  });
});
