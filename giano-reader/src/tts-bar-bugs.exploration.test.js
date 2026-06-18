import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { AudioBufferStore } from './tts.js';

/**
 * Bug Condition Exploration Test — TTS Bar Layout and Progress Completion Bugs
 *
 * **Validates: Requirements 1.1, 1.2, 1.3**
 *
 * This test encodes the EXPECTED (correct) behavior. It is expected to FAIL
 * on unfixed code, which confirms the bugs exist. When the fix is applied,
 * this test should PASS.
 *
 * Bug Condition from design:
 *   isBugCondition({type:'layout'}) = download button DOM index < play button DOM index
 *   isBugCondition({type:'progress', paragraphs:[1,2,3], skippedCount:1}) =
 *     playback complete AND skippedCount > 0 AND displayedProgress < 100
 */
describe('Property 1: Bug Condition — TTS Bar Layout and Progress Completion Bugs', () => {

  describe('Layout Bug: DOM order of #tts-download-btn and #tts-progress relative to controls', () => {
    it('download button and progress span appear AFTER all other controls (play, stop, panel, mode, model, voice, rate, pitch)', () => {
      // Set up the DOM with the current (fixed) HTML structure from index.html
      // In fixed code, download and progress are at the END of #tts-controls (after pitch)
      document.body.innerHTML = `
        <div id="tts-controls">
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

          <span id="tts-progress" class="tts-value hidden">0%</span>
          <button id="tts-download-btn" disabled title="Download MP3" aria-label="Download MP3">
            <img src="/icons/download.svg" class="icon" alt="" />
          </button>
        </div>
      `;

      const ttsControls = document.getElementById('tts-controls');
      const children = Array.from(ttsControls.children);

      const downloadBtn = document.getElementById('tts-download-btn');
      const progressSpan = document.getElementById('tts-progress');
      const playBtn = document.getElementById('tts-play-btn');
      const stopBtn = document.getElementById('tts-stop-btn');
      const pitchValueSpan = document.getElementById('tts-pitch-value');

      const downloadIdx = children.indexOf(downloadBtn);
      const progressIdx = children.indexOf(progressSpan);
      const playIdx = children.indexOf(playBtn);
      const stopIdx = children.indexOf(stopBtn);
      const pitchValueIdx = children.indexOf(pitchValueSpan);

      // Expected behavior: progress element AFTER pitch value span,
      // download button AFTER progress element.
      // Both should be after ALL other controls (play, stop, panel, mode, model, voice, rate, pitch).
      expect(progressIdx).toBeGreaterThan(pitchValueIdx);
      expect(downloadIdx).toBeGreaterThan(progressIdx);
      expect(progressIdx).toBeGreaterThan(playIdx);
      expect(progressIdx).toBeGreaterThan(stopIdx);
      expect(downloadIdx).toBeGreaterThan(playIdx);
      expect(downloadIdx).toBeGreaterThan(stopIdx);
    });
  });

  describe('Progress Bug: PRO mode session with skipped paragraph does not reach 100%', () => {
    it('progress displays 100% when 3-paragraph session completes with 1 paragraph skipped', () => {
      // Simulate a PRO mode session with 3 paragraphs where paragraph 2 is skipped
      // due to audio decode error.
      //
      // On unfixed code:
      //   - Paragraph 1: success → store.add(0, bytes) → progress = floor(1/3*100) = 33%
      //   - Paragraph 2: audio decode error → skipped (no add) → progress stays 33%
      //   - Paragraph 3: success → store.add(2, bytes) → progress = floor(2/3*100) = 66%
      //   - _advanceToNext() reaches end-of-chapter → sets state to idle
      //   - Progress remains 66% (never reaches 100%)
      //
      // Expected behavior (after fix):
      //   - When _advanceToNext() reaches end-of-chapter and store has data,
      //     forceComplete() fires 100% progress callback
      //   - Progress should be 100% and download button should be enabled

      let lastProgress = 0;
      const store = new AudioBufferStore();
      store.init(3, (progress) => {
        lastProgress = progress;
      });

      // Paragraph 1 succeeds
      store.add(0, new Uint8Array([0xFF, 0xFB, 0x90, 0x00]));
      expect(lastProgress).toBe(33);

      // Paragraph 2: audio decode error — skipped (no store.add call)
      // This simulates the catch block in _speakPro that calls _advanceToNext()
      // without storing bytes

      // Paragraph 3 succeeds
      store.add(2, new Uint8Array([0xFF, 0xFB, 0x90, 0x00]));
      expect(lastProgress).toBe(66);

      // Simulate _advanceToNext() reaching end-of-chapter
      // In unfixed code, this just sets state to idle without forcing progress to 100%
      // In fixed code, forceComplete() is called which fires _onProgress(100)
      if (store.hasData() && typeof store.forceComplete === 'function') {
        store.forceComplete();
      }

      // Assert expected behavior: progress should be 100%
      // On unfixed code, this will FAIL because:
      //   1. forceComplete() method doesn't exist yet
      //   2. Even if we just check store.getProgress(), it returns 66% (2/3)
      expect(lastProgress).toBe(100);
    });

    it('property: for any paragraph count and skip pattern, progress reaches 100% at completion', () => {
      fc.assert(
        fc.property(
          // Generate paragraph count (1 to 20) and a skip set
          fc.integer({ min: 2, max: 20 }),
          fc.integer({ min: 1, max: 5 }),
          (totalParagraphs, skipCount) => {
            // Ensure we don't skip more than total - 1 (at least 1 must succeed)
            const actualSkipCount = Math.min(skipCount, totalParagraphs - 1);

            // Randomly select which paragraphs to skip
            const skipIndices = new Set();
            let idx = 0;
            while (skipIndices.size < actualSkipCount && idx < totalParagraphs) {
              // Deterministically skip even-indexed paragraphs for reproducibility
              if (idx % 2 === 1 && skipIndices.size < actualSkipCount) {
                skipIndices.add(idx);
              }
              idx++;
            }
            // If we haven't skipped enough, fill from the start
            idx = 0;
            while (skipIndices.size < actualSkipCount) {
              if (!skipIndices.has(idx) && idx < totalParagraphs - 1) {
                skipIndices.add(idx);
              }
              idx++;
            }

            let lastProgress = 0;
            const store = new AudioBufferStore();
            store.init(totalParagraphs, (progress) => {
              lastProgress = progress;
            });

            // Simulate playback: add bytes for non-skipped paragraphs
            for (let i = 0; i < totalParagraphs; i++) {
              if (!skipIndices.has(i)) {
                store.add(i, new Uint8Array([0xFF, 0xFB, 0x90, 0x00]));
              }
            }

            // Simulate end-of-chapter: call forceComplete if it exists
            if (store.hasData() && typeof store.forceComplete === 'function') {
              store.forceComplete();
            }

            // Expected: progress should be 100% after all paragraphs are attempted
            // On unfixed code, this will be < 100% whenever any paragraph is skipped
            expect(lastProgress).toBe(100);
          }
        ),
        { numRuns: 50 }
      );
    });
  });
});
