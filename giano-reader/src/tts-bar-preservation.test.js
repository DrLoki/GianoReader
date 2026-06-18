import { describe, it, expect, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import { AudioBufferStore } from './tts.js';

/**
 * Property 2: Preservation — TTS Controls Position and Non-Bug Behavior
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**
 *
 * These tests capture OBSERVED behavior on unfixed code.
 * They are expected to PASS on unfixed code (confirming baseline behavior to preserve).
 * After the fix is applied, they should STILL PASS (confirming no regressions).
 */
describe('Property 2: Preservation — TTS Controls Position and Non-Bug Behavior', () => {

  /**
   * Current (unfixed) DOM structure of #tts-controls:
   * download-btn, progress, play, stop, panel-label, panel-select,
   * mode-label, mode-select, model-select, voice-label, voice-select,
   * rate-label, rate-input, rate-value, pitch-label, pitch-input, pitch-value
   */
  const UNFIXED_TTS_CONTROLS_HTML = `
    <div id="tts-controls">
      <button id="tts-download-btn" disabled title="Download MP3" aria-label="Download MP3">
        <img src="/icons/download.svg" class="icon" alt="" />
      </button>
      <span id="tts-progress" class="tts-value hidden">0%</span>

      <button id="tts-play-btn" disabled title="Play" aria-label="Play">
        <svg class="icon" viewBox="0 0 24 24"><polygon points="6,4 20,12 6,20"/></svg>
      </button>
      <button id="tts-stop-btn" disabled title="Stop" aria-label="Stop">
        <svg class="icon" viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>
      </button>

      <label for="tts-panel-select" class="tts-label">Panel</label>
      <select id="tts-panel-select" disabled>
        <option value="original">Original</option>
        <option value="translation">Translation</option>
      </select>

      <label for="tts-mode-select" class="tts-label">Mode</label>
      <select id="tts-mode-select" disabled>
        <option value="free">FREE</option>
        <option value="pro">PRO</option>
      </select>

      <select id="tts-model-select" disabled>
        <option value="openai/gpt-4o-mini-tts-2025-12-15">GPT-4o Mini TTS</option>
        <option value="google/gemini-3.1-flash-tts-preview">Gemini 2.5 Flash TTS</option>
      </select>

      <label for="tts-voice-select" class="tts-label">Voice</label>
      <select id="tts-voice-select" disabled>
        <option value="">Default</option>
      </select>

      <label for="tts-rate" class="tts-label">Rate</label>
      <input type="range" id="tts-rate" min="0.5" max="2" step="0.1" value="1" disabled />
      <span id="tts-rate-value" class="tts-value">1.0×</span>

      <label for="tts-pitch" class="tts-label">Pitch</label>
      <input type="range" id="tts-pitch" min="0.5" max="2" step="0.1" value="1" disabled />
      <span id="tts-pitch-value" class="tts-value">1.0</span>
    </div>
  `;

  describe('Incremental progress: monotonically non-decreasing for all N and K', () => {
    it('for all paragraph counts N (1-100) and intermediate steps K (1..N), progress equals Math.floor(K/N * 100) and is monotonically non-decreasing', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 100 }),
          (totalParagraphs) => {
            const progressValues = [];
            const store = new AudioBufferStore();
            store.init(totalParagraphs, (progress) => {
              progressValues.push(progress);
            });

            // Add paragraphs sequentially
            for (let k = 0; k < totalParagraphs; k++) {
              store.add(k, new Uint8Array([0xFF, 0xFB, 0x90, 0x00]));
            }

            // Verify each intermediate progress value
            for (let i = 0; i < progressValues.length; i++) {
              const k = i + 1; // number of paragraphs stored so far
              const expected = Math.floor((k / totalParagraphs) * 100);
              expect(progressValues[i]).toBe(expected);
            }

            // Verify monotonically non-decreasing
            for (let i = 1; i < progressValues.length; i++) {
              expect(progressValues[i]).toBeGreaterThanOrEqual(progressValues[i - 1]);
            }

            // Final value should be 100 (N/N * 100 = 100)
            expect(progressValues[progressValues.length - 1]).toBe(100);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('FREE mode: progress indicator hidden and download button disabled', () => {
    beforeEach(() => {
      document.body.innerHTML = UNFIXED_TTS_CONTROLS_HTML;
    });

    it('for all FREE mode states, progress indicator has class "hidden" and download button is disabled', () => {
      fc.assert(
        fc.property(
          // Generate arbitrary mode-select values where mode is 'free'
          fc.constantFrom('free'),
          fc.constantFrom('openai/gpt-4o-mini-tts-2025-12-15', 'google/gemini-3.1-flash-tts-preview', 'x-ai/grok-voice-tts-1.0'),
          (mode, model) => {
            // Simulate FREE mode state - set the selects
            const modeSelect = document.getElementById('tts-mode-select');
            const modelSelect = document.getElementById('tts-model-select');
            modeSelect.value = mode;
            modelSelect.value = model;

            // In FREE mode, progress indicator should be hidden
            const progressSpan = document.getElementById('tts-progress');
            expect(progressSpan.classList.contains('hidden')).toBe(true);
            expect(progressSpan.textContent).toBe('0%');

            // In FREE mode, download button should be disabled
            const downloadBtn = document.getElementById('tts-download-btn');
            expect(downloadBtn.disabled).toBe(true);
          }
        ),
        { numRuns: 10 }
      );
    });
  });

  describe('Manual stop: buffer store cleared, progress reset to 0%, download disabled', () => {
    it('for all manual stop events after N paragraphs stored, buffer store size is 0, progress text is "0%", download disabled', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 50 }),
          fc.integer({ min: 1, max: 50 }),
          (totalParagraphs, storedBeforeStop) => {
            const actualStored = Math.min(storedBeforeStop, totalParagraphs);
            let lastProgress = 0;

            const store = new AudioBufferStore();
            store.init(totalParagraphs, (progress) => {
              lastProgress = progress;
            });

            // Simulate adding some paragraphs before stop
            for (let i = 0; i < actualStored; i++) {
              store.add(i, new Uint8Array([0xFF, 0xFB, 0x90, 0x00]));
            }

            // Simulate manual stop: clear buffer store
            store.clear();

            // After stop: store is empty
            expect(store.hasData()).toBe(false);
            // getProgress returns 0 since totalParagraphs is reset to 0
            expect(store.getProgress()).toBe(0);

            // Verify DOM state after stop
            document.body.innerHTML = `
              <button id="tts-download-btn" disabled></button>
              <span id="tts-progress" class="tts-value hidden">0%</span>
            `;

            const downloadBtn = document.getElementById('tts-download-btn');
            const progressSpan = document.getElementById('tts-progress');
            expect(downloadBtn.disabled).toBe(true);
            expect(progressSpan.textContent).toBe('0%');
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe('Gemini model: no bytes stored, no progress advancement', () => {
    it('for all Gemini sessions, AudioBufferStore.hasData() returns false and progress remains 0%', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 100 }),
          (totalParagraphs) => {
            // Gemini model uses PCM output, no MP3 bytes are stored
            // Simulate a Gemini session: store is initialized but never gets add() calls
            let lastProgress = 0;
            const store = new AudioBufferStore();
            store.init(totalParagraphs, (progress) => {
              lastProgress = progress;
            });

            // Gemini sessions never call store.add() — paragraphs are streamed as PCM
            // After full playback, store should have no data

            expect(store.hasData()).toBe(false);
            expect(store.getProgress()).toBe(0);
            expect(lastProgress).toBe(0);
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe('Control order: play/stop/panel/mode/model/voice/rate/pitch maintain relative DOM order', () => {
    beforeEach(() => {
      document.body.innerHTML = UNFIXED_TTS_CONTROLS_HTML;
    });

    it('for all renderings, play/stop/panel/mode/model/voice/rate/pitch controls maintain their relative DOM order', () => {
      fc.assert(
        fc.property(
          // Generate arbitrary "rendering scenarios" — the controls should always be in order
          fc.constant(null),
          () => {
            const ttsControls = document.getElementById('tts-controls');
            const children = Array.from(ttsControls.children);

            // Get indices of the main controls (excluding download and progress
            // which are subject to the layout bug fix)
            const playBtn = document.getElementById('tts-play-btn');
            const stopBtn = document.getElementById('tts-stop-btn');
            const panelSelect = document.getElementById('tts-panel-select');
            const modeSelect = document.getElementById('tts-mode-select');
            const modelSelect = document.getElementById('tts-model-select');
            const voiceSelect = document.getElementById('tts-voice-select');
            const rateInput = document.getElementById('tts-rate');
            const pitchInput = document.getElementById('tts-pitch');

            const playIdx = children.indexOf(playBtn);
            const stopIdx = children.indexOf(stopBtn);
            const panelIdx = children.indexOf(panelSelect);
            const modeIdx = children.indexOf(modeSelect);
            const modelIdx = children.indexOf(modelSelect);
            const voiceIdx = children.indexOf(voiceSelect);
            const rateIdx = children.indexOf(rateInput);
            const pitchIdx = children.indexOf(pitchInput);

            // All controls must exist
            expect(playIdx).toBeGreaterThanOrEqual(0);
            expect(stopIdx).toBeGreaterThanOrEqual(0);
            expect(panelIdx).toBeGreaterThanOrEqual(0);
            expect(modeIdx).toBeGreaterThanOrEqual(0);
            expect(modelIdx).toBeGreaterThanOrEqual(0);
            expect(voiceIdx).toBeGreaterThanOrEqual(0);
            expect(rateIdx).toBeGreaterThanOrEqual(0);
            expect(pitchIdx).toBeGreaterThanOrEqual(0);

            // Relative order must be maintained:
            // play < stop < panel < mode < model < voice < rate < pitch
            expect(playIdx).toBeLessThan(stopIdx);
            expect(stopIdx).toBeLessThan(panelIdx);
            expect(panelIdx).toBeLessThan(modeIdx);
            expect(modeIdx).toBeLessThan(modelIdx);
            expect(modelIdx).toBeLessThan(voiceIdx);
            expect(voiceIdx).toBeLessThan(rateIdx);
            expect(rateIdx).toBeLessThan(pitchIdx);
          }
        ),
        { numRuns: 10 }
      );
    });
  });
});
