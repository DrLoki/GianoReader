/**
 * tts.js
 *
 * Text-to-Speech module for Giano Reader.
 * Provides two engines: FREE (Web Speech API) and PRO (OpenRouter TTS).
 * Follows the same module pattern as translator.js.
 */

// ---------------------------------------------------------------------------
// Language mapping
// ---------------------------------------------------------------------------

export const LANG_TO_BCP47 = {
  it: 'it-IT',
  en: 'en-US',
  fr: 'fr-FR',
  de: 'de-DE',
  es: 'es-ES',
  pt: 'pt-PT',
  ru: 'ru-RU',
  zh: 'zh-CN',
  ja: 'ja-JP',
  ar: 'ar-SA',
  fil: 'fil-PH',
  sq: 'sq-AL',
  hi: 'hi-IN',
  ko: 'ko-KR',
  th: 'th-TH',
  bn: 'bn-BD',
  id: 'id-ID',
  sv: 'sv-SE',
  uk: 'uk-UA',
  sl: 'sl-SI'
};

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem('giano-reader-settings') || '{}');
  } catch {
    return {};
  }
}

function saveSettings(partial) {
  const current = loadSettings();
  const updated = { ...current, ...partial };
  localStorage.setItem('giano-reader-settings', JSON.stringify(updated));
  return updated;
}

/**
 * Determines whether PRO mode is available based on the API key.
 * @param {string|undefined} apiKey
 * @returns {boolean}
 */
export function isProModeAvailable(apiKey) {
  if (!apiKey || typeof apiKey !== 'string') return false;
  return apiKey.startsWith('sk-or-') && apiKey.length >= 20;
}

// ---------------------------------------------------------------------------
// PositionTracker
// ---------------------------------------------------------------------------

export class PositionTracker {
  /**
   * Highlight the paragraph at the given index, removing any previous highlight.
   * @param {HTMLElement} panelEl - The panel DOM element containing paragraphs.
   * @param {number} index - The data-idx of the paragraph to highlight.
   */
  highlight(panelEl, index) {
    if (!panelEl) return;
    // Remove existing highlights
    this.clear(panelEl);
    // Add highlight to the target paragraph
    const el = panelEl.querySelector(`[data-idx="${index}"]`);
    if (el) {
      el.classList.add('tts-speaking');
    }
  }

  /**
   * Auto-scroll the panel to keep the highlighted paragraph visible.
   * @param {HTMLElement} panelEl
   * @param {number} index
   */
  scrollToVisible(panelEl, index) {
    if (!panelEl) return;
    const el = panelEl.querySelector(`[data-idx="${index}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  /**
   * Remove all TTS highlights from the panel.
   * @param {HTMLElement} panelEl
   */
  clear(panelEl) {
    if (!panelEl) return;
    const highlighted = panelEl.querySelectorAll('.tts-speaking');
    highlighted.forEach(el => el.classList.remove('tts-speaking'));
  }
}

// ---------------------------------------------------------------------------
// FreeTTSEngine
// ---------------------------------------------------------------------------

export class FreeTTSEngine {
  constructor() {
    this._synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
    this._currentUtterance = null;
    this._chromeResumeInterval = null;
  }

  /**
   * Get available voices filtered by language code using BCP-47 prefix matching.
   * Matches voices where:
   *   - voice.lang starts with the full BCP-47 prefix (e.g., 'it-IT' matches 'it-IT', 'it-IT-extra')
   *   - voice.lang equals just the language part (e.g., 'it' matches for Italian)
   * Returns empty array when no voices match (caller handles notification).
   * @param {string} langCode - Short language code (e.g. 'en', 'it').
   * @returns {SpeechSynthesisVoice[]}
   */
  getVoicesForLang(langCode) {
    if (!this._synth) return [];
    const bcp47Prefix = LANG_TO_BCP47[langCode];
    if (!bcp47Prefix) return [];

    const fullPrefix = bcp47Prefix.toLowerCase(); // e.g. 'it-it'
    const langPart = fullPrefix.split('-')[0];     // e.g. 'it'

    return this._synth.getVoices().filter(v => {
      const voiceLang = v.lang.toLowerCase();
      // Match exact full prefix or full prefix followed by more subtags
      if (voiceLang === fullPrefix || voiceLang.startsWith(fullPrefix + '-')) {
        return true;
      }
      // Also match voices that only specify the language part (e.g. 'it')
      if (voiceLang === langPart) {
        return true;
      }
      return false;
    });
  }

  /**
   * Speak a single paragraph of text.
   * @param {string} text
   * @param {Object} options
   * @param {SpeechSynthesisVoice} [options.voice]
   * @param {number} [options.rate=1.0]
   * @param {number} [options.pitch=1.0]
   * @param {Function} [options.onEnd]
   * @param {Function} [options.onError]
   */
  speak(text, { voice, rate = 1.0, pitch = 1.0, onEnd, onError } = {}) {
    if (!this._synth) {
      if (onError) onError(new Error('Speech synthesis not available'));
      return;
    }

    const utterance = new SpeechSynthesisUtterance(text);
    if (voice) utterance.voice = voice;
    utterance.rate = rate;
    utterance.pitch = pitch;

    utterance.onend = () => {
      this._stopChromeWorkaround();
      this._currentUtterance = null;
      if (onEnd) onEnd();
    };

    utterance.onerror = (event) => {
      this._stopChromeWorkaround();
      this._currentUtterance = null;
      // 'interrupted' and 'canceled' are not real errors — they happen on cancel/stop
      if (event.error === 'interrupted' || event.error === 'canceled') return;
      if (onError) onError(new Error(event.error || 'Speech synthesis error'));
    };

    this._currentUtterance = utterance;
    this._synth.speak(utterance);

    // Chrome throttle workaround: Chrome stops speaking after ~15s of continuous
    // speech. Periodically calling pause()/resume() keeps it alive.
    this._startChromeWorkaround();
  }

  /**
   * Start the Chrome workaround interval that periodically pauses/resumes
   * to prevent Chrome from killing long utterances (~15s limit).
   */
  _startChromeWorkaround() {
    this._stopChromeWorkaround();
    // Only needed in Chromium-based browsers
    const isChromium = typeof window !== 'undefined' &&
      (window.chrome !== undefined || /Chrome|Chromium|Edg/.test(navigator.userAgent));
    if (!isChromium || !this._synth) return;

    this._chromeResumeInterval = setInterval(() => {
      if (this._synth && this._synth.speaking && !this._synth.paused) {
        this._synth.pause();
        this._synth.resume();
      }
    }, 10000); // every 10 seconds, well before the ~15s Chrome limit
  }

  /**
   * Stop the Chrome workaround interval.
   */
  _stopChromeWorkaround() {
    if (this._chromeResumeInterval) {
      clearInterval(this._chromeResumeInterval);
      this._chromeResumeInterval = null;
    }
  }

  /** Pause current utterance. */
  pause() {
    if (this._synth) this._synth.pause();
  }

  /** Resume paused utterance. */
  resume() {
    if (this._synth) this._synth.resume();
  }

  /** Cancel all queued utterances. */
  cancel() {
    this._stopChromeWorkaround();
    if (this._synth) this._synth.cancel();
    this._currentUtterance = null;
  }
}

// ---------------------------------------------------------------------------
// ProTTSEngine
// ---------------------------------------------------------------------------

export class ProTTSEngine {
  constructor() {
    this._audioContext = null;
    this._sourceNode = null;
    this._startedAt = 0;
    this._pausedAt = 0;
    this._currentBuffer = null;
    this._playing = false;
    this._resolvePlay = null;
  }

  /**
   * Ensure AudioContext is initialized.
   * @returns {AudioContext}
   */
  _getAudioContext() {
    if (!this._audioContext) {
      this._audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    return this._audioContext;
  }

  /**
   * Synthesize audio for a paragraph via OpenRouter API.
   * @param {string} text
   * @param {Object} options
   * @param {string} options.model - OpenRouter TTS model ID
   * @param {string} options.voice - Voice ID (e.g. 'alloy')
   * @param {number} [options.speed=1.0]
   * @param {string} [options.lang] - Language code
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<{audioBuffer: AudioBuffer, rawMp3Bytes: Uint8Array|null}>}
   */
  async synthesize(text, { model, voice, speed = 1.0, lang, signal } = {}) {
    const settings = loadSettings();
    const apiKey = settings.openrouterApiKey;

    if (!apiKey) throw new Error('OpenRouter API key not configured');

    // Gemini TTS models only support PCM format
    const isGemini = model && model.includes('gemini');
    const responseFormat = isGemini ? 'pcm' : 'mp3';

    const url = 'https://openrouter.ai/api/v1/audio/speech';
    const body = {
      model,
      input: text,
      voice,
      response_format: responseFormat,
      speed
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://github.com/DrLoki/GianoReader',
        'X-Title': 'GianoReader'
      },
      body: JSON.stringify(body),
      signal
    });

    if (!res.ok) {
      let message = `OpenRouter TTS error (${res.status})`;
      let detail = '';
      try {
        const errData = await res.json();
        if (errData.error?.message) {
          message += `: ${errData.error.message}`;
        }
        detail = JSON.stringify(errData, null, 2);
      } catch {
        detail = await res.text().catch(() => '');
        if (detail) message += `: ${detail.substring(0, 200)}`;
      }
      // Log full error detail to console for debugging
      console.error('[TTS] OpenRouter error response:', {
        status: res.status,
        statusText: res.statusText,
        headers: Object.fromEntries(res.headers.entries()),
        body: detail,
        request: { model, voice, speed, responseFormat, textLength: text.length }
      });
      throw new Error(message);
    }

    const arrayBuffer = await res.arrayBuffer();
    const audioCtx = this._getAudioContext();

    // PCM from Gemini is raw 24kHz 16-bit signed little-endian mono
    if (isGemini) {
      const pcmData = new Int16Array(arrayBuffer);
      const floatData = new Float32Array(pcmData.length);
      for (let i = 0; i < pcmData.length; i++) {
        floatData[i] = pcmData[i] / 32768;
      }
      const audioBuffer = audioCtx.createBuffer(1, floatData.length, 24000);
      audioBuffer.getChannelData(0).set(floatData);
      // Store raw PCM bytes for WAV download
      const rawMp3Bytes = new Uint8Array(arrayBuffer.slice(0));
      return { audioBuffer, rawMp3Bytes };
    }

    // MP3 path — clone bytes BEFORE decodeAudioData consumes them
    const rawMp3Bytes = new Uint8Array(arrayBuffer.slice(0));
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    return { audioBuffer, rawMp3Bytes };
  }

  /**
   * Play an AudioBuffer. Returns a promise that resolves when playback ends.
   * @param {AudioBuffer} buffer
   * @returns {Promise<void>}
   */
  play(buffer) {
    return new Promise((resolve, reject) => {
      try {
        const audioCtx = this._getAudioContext();

        // Resume context if suspended (browser autoplay policy)
        if (audioCtx.state === 'suspended') {
          audioCtx.resume();
        }

        this._currentBuffer = buffer;
        this._pausedAt = 0;
        this._resolvePlay = resolve;

        const source = audioCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(audioCtx.destination);

        source.onended = () => {
          this._playing = false;
          this._sourceNode = null;
          if (this._resolvePlay) {
            this._resolvePlay();
            this._resolvePlay = null;
          }
        };

        this._sourceNode = source;
        this._startedAt = audioCtx.currentTime;
        source.start(0);
        this._playing = true;
      } catch (err) {
        reject(err);
      }
    });
  }

  /** Pause audio playback. */
  pause() {
    if (!this._playing || !this._audioContext) return;
    this._pausedAt = this._audioContext.currentTime - this._startedAt;
    this._audioContext.suspend();
    this._playing = false;
  }

  /** Resume audio playback. */
  resume() {
    if (!this._audioContext) return;
    this._audioContext.resume();
    this._playing = true;
  }

  /** Stop playback and release resources. */
  stop() {
    if (this._sourceNode) {
      try {
        this._sourceNode.stop();
      } catch { /* already stopped */ }
      this._sourceNode = null;
    }
    this._playing = false;
    this._currentBuffer = null;
    this._pausedAt = 0;
    this._startedAt = 0;
    if (this._resolvePlay) {
      this._resolvePlay();
      this._resolvePlay = null;
    }
  }
}

// ---------------------------------------------------------------------------
// TTSController
// ---------------------------------------------------------------------------

export class TTSController {
  constructor() {
    this._state = 'idle'; // 'idle' | 'playing' | 'paused'
    this._currentIndex = 0;
    this._paragraphs = [];
    this._settings = {
      mode: 'free',
      voiceURI: '',
      ttsModel: 'canopylabs/orpheus-3b-0.1-ft',
      rate: 1.0,
      pitch: 1.0,
      panel: 'original',
      ttsVoice: 'tara'
    };

    this._originalViewer = null;
    this._translationViewer = null;
    this._onStateChange = null;
    this._onError = null;
    this._onProgressChange = null; // Callback for download progress updates

    this._freeEngine = new FreeTTSEngine();
    this._proEngine = new ProTTSEngine();
    this._tracker = new PositionTracker();
    this._abortController = null;

    // PRO mode lookahead buffer: pre-fetches next N paragraphs while current plays
    this._prefetchCache = new Map(); // Map<paragraphIndex, Promise<{audioBuffer, rawMp3Bytes}>>
    this._prefetchAbort = null;
    this._LOOKAHEAD = 3; // number of paragraphs to pre-fetch ahead

    // Translation lookahead and timeout constants
    this._TRANSLATION_LOOKAHEAD = 24; // 2 full chunks ahead for TTS lead time
    this._TRANSLATION_TIMEOUT = 30000; // 30 seconds

    // Translation trigger callback (provided by main.js)
    this._onTranslationNeeded = null;

    // Retry translation callback (provided by main.js)
    this._onRetryTranslation = null;

    // Audio buffer store for MP3 download
    this._bufferStore = new AudioBufferStore();
    this._isGeminiSession = false;
  }

  /**
   * Initialize the TTS controller with DOM references and settings.
   * @param {Object} options
   * @param {HTMLElement} options.originalViewer
   * @param {HTMLElement} options.translationViewer
   * @param {Object} [options.settings] - Initial TTS settings override
   * @param {Function} [options.onStateChange] - Callback when state changes
   * @param {Function} [options.onError] - Callback when a fatal error occurs (stops playback)
   * @param {Function} [options.onTranslationNeeded] - Callback to trigger translation for a range of paragraph indices
   * @param {Function} [options.onRetryTranslation] - Callback to clear chunk from cache and re-trigger translation
   */
  init({ originalViewer, translationViewer, settings, onStateChange, onError, onTranslationNeeded, onRetryTranslation }) {
    this._originalViewer = originalViewer;
    this._translationViewer = translationViewer;
    this._onStateChange = onStateChange || null;
    this._onError = onError || null;
    this._onTranslationNeeded = onTranslationNeeded || null;
    this._onRetryTranslation = onRetryTranslation || null;

    // Restore persisted settings
    const stored = loadSettings();
    this._settings = {
      mode: stored.ttsMode || 'free',
      voiceURI: stored.ttsVoiceURI || '',
      ttsModel: stored.ttsModel || 'canopylabs/orpheus-3b-0.1-ft',
      rate: stored.ttsRate ?? 1.0,
      pitch: stored.ttsPitch ?? 1.0,
      panel: stored.ttsPanel || 'original',
      ttsVoice: stored.ttsVoice || 'alloy'
    };

    // Apply any explicit settings override
    if (settings) {
      this._settings = { ...this._settings, ...settings };
    }
  }

  /**
   * Start or resume playback.
   */
  play() {
    if (this._state === 'paused') {
      this._resume();
      return;
    }

    if (this._state === 'idle') {
      this._buildQueue();
      if (this._paragraphs.length === 0) return;

      // Initialize audio buffer store for new session
      this._bufferStore.init(this._paragraphs.length, (pct) => {
        if (this._onProgressChange) this._onProgressChange(pct);
      });
      this._isGeminiSession = (this._settings.ttsModel || '').includes('gemini');

      this._setState('playing');
      this._speakCurrent();
    }
  }

  /**
   * Pause playback (retains position).
   */
  pause() {
    if (this._state !== 'playing') return;

    if (this._settings.mode === 'free') {
      this._freeEngine.pause();
    } else {
      this._proEngine.pause();
    }

    this._setState('paused');
  }

  /**
   * Stop playback and reset to beginning.
   */
  stop() {
    if (this._state === 'idle') return;

    this._cancelAll();
    // Reset reading progress on user stop
    if (this._paragraphs.length > 0 && this._onProgressChange) {
      this._onProgressChange(0);
    }
    this._currentIndex = 0;
    this._paragraphs = [];
    this._bufferStore.clear();
    this._setState('idle');
    this._clearHighlight();
  }

  /**
   * Update settings (partial merge).
   * @param {Object} partial
   */
  updateSettings(partial) {
    const previousPanel = this._settings.panel;
    this._settings = { ...this._settings, ...partial };

    // Persist to localStorage
    const toStore = {};
    if (partial.mode !== undefined) toStore.ttsMode = partial.mode;
    if (partial.voiceURI !== undefined) toStore.ttsVoiceURI = partial.voiceURI;
    if (partial.ttsModel !== undefined) toStore.ttsModel = partial.ttsModel;
    if (partial.rate !== undefined) toStore.ttsRate = partial.rate;
    if (partial.pitch !== undefined) toStore.ttsPitch = partial.pitch;
    if (partial.panel !== undefined) toStore.ttsPanel = partial.panel;
    if (partial.ttsVoice !== undefined) toStore.ttsVoice = partial.ttsVoice;

    if (Object.keys(toStore).length > 0) {
      saveSettings(toStore);
    }

    // Handle panel switch while TTS is active: stop and restart from current position
    if (partial.panel !== undefined && partial.panel !== previousPanel) {
      if (this._state === 'playing' || this._state === 'paused') {
        const savedIndex = this._currentIndex;
        this._cancelAll();
        this._clearHighlight();
        this._bufferStore.clear();
        this._buildQueue();
        // Clamp savedIndex to the new queue length
        this._currentIndex = Math.min(savedIndex, Math.max(0, this._paragraphs.length - 1));
        if (this._paragraphs.length > 0) {
          // Re-init buffer store for the new panel session
          this._bufferStore.init(this._paragraphs.length, (pct) => {
            if (this._onProgressChange) this._onProgressChange(pct);
          });
          this._setState('playing');
          this._speakCurrent();
        } else {
          this._currentIndex = 0;
          this._setState('idle');
        }
      }
    }
  }

  /**
   * Get current TTS state.
   * @returns {{ status: string, currentIndex: number, panel: string }}
   */
  getState() {
    return {
      status: this._state,
      currentIndex: this._currentIndex,
      panel: this._settings.panel
    };
  }

  /**
   * Get the assembled audio blob from the audio buffer store.
   * Returns MP3 for non-Gemini models, WAV for Gemini models.
   * @returns {Blob} Audio blob containing all accumulated audio in paragraph order
   */
  getAudioBlob() {
    if (this._isGeminiSession) {
      return this._bufferStore.assembleWavBlob();
    }
    return this._bufferStore.assembleBlob();
  }

  /**
   * Check whether any audio data has been accumulated in the buffer store.
   * @returns {boolean}
   */
  hasAudioData() {
    return this._bufferStore.hasData();
  }

  /**
   * Clean up resources.
   */
  destroy() {
    this.stop();
    this._freeEngine.cancel();
    this._proEngine.stop();
    this._originalViewer = null;
    this._translationViewer = null;
    this._onStateChange = null;
    this._onError = null;
  }

  // -------------------------------------------------------------------------
  // Private methods
  // -------------------------------------------------------------------------

  /**
   * Build the paragraph queue from the active panel's DOM.
   */
  _buildQueue() {
    const panel = this._getActivePanel();
    if (!panel) {
      this._paragraphs = [];
      return;
    }

    const elements = panel.querySelectorAll('[data-idx]');
    this._paragraphs = [];
    elements.forEach(el => {
      // Clone the element and remove paragraph number spans to avoid reading them aloud
      const clone = el.cloneNode(true);
      clone.querySelectorAll('.para-num').forEach(n => n.remove());
      const text = (clone.textContent || '').trim();
      if (text) {
        this._paragraphs.push({
          index: parseInt(el.getAttribute('data-idx'), 10),
          text,
          element: el
        });
      }
    });
  }

  /**
   * Get the active panel element based on settings.
   * @returns {HTMLElement|null}
   */
  _getActivePanel() {
    if (this._settings.panel === 'translation') {
      return this._translationViewer;
    }
    return this._originalViewer;
  }

  /**
   * Ensure a paragraph is translated before reading it.
   * Checks for `data-translated="true"` attribute as the positive signal of
   * genuine translation success. Triggers translation and waits with retry logic.
   * No-op for already-translated paragraphs (returns immediately).
   *
   * @param {number} queueIndex - Index in this._paragraphs array
   * @returns {Promise<void>}
   */
  async _ensureTranslated(queueIndex) {
    const item = this._paragraphs[queueIndex];
    if (!item || !item.element) return;

    // Already translated — proceed immediately
    if (item.element.getAttribute('data-translated') === 'true') {
      this._refreshItemText(item);
      return;
    }

    // Trigger translation for the target paragraph and lookahead range
    if (this._onTranslationNeeded) {
      const currentIdx = item.index;
      try {
        await this._onTranslationNeeded(currentIdx, currentIdx + this._TRANSLATION_LOOKAHEAD);
      } catch (err) {
        console.warn('[TTS] Translation trigger error for paragraph', currentIdx, err);
      }
    }

    // Check if translation completed synchronously (fast network)
    if (item.element.getAttribute('data-translated') === 'true') {
      this._refreshItemText(item);
      return;
    }

    // Wait with retry loop
    const signal = this._abortController ? this._abortController.signal : null;
    const RETRY_TIMEOUT = 60000; // 60 seconds per attempt
    const MAX_RETRIES = 2;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const translated = await this._waitForDataTranslated(item, signal, RETRY_TIMEOUT);

      if (signal && signal.aborted) return;

      if (translated) {
        this._refreshItemText(item);
        return;
      }

      // Timed out — retry if attempts remain
      if (attempt < MAX_RETRIES) {
        console.warn(`[TTS] Translation timeout for paragraph ${item.index}, retry ${attempt + 1}/${MAX_RETRIES}`);
        // Clear the chunk from cache so translateChunk will actually re-run
        if (this._onRetryTranslation) {
          this._onRetryTranslation(item.index);
        }
        // Re-trigger translation
        if (this._onTranslationNeeded) {
          try {
            await this._onTranslationNeeded(item.index, item.index + this._TRANSLATION_LOOKAHEAD);
          } catch (err) {
            console.warn('[TTS] Retry translation trigger error', err);
          }
        }
      }
    }

    // All retries exhausted — skip paragraph
    console.warn(`[TTS] Giving up on paragraph ${item.index} after ${MAX_RETRIES} retries (120s) — skipping`);
  }

  /**
   * Re-read the element's textContent and update the queue item's text.
   * Strips .para-num spans to avoid reading paragraph numbers aloud.
   * @param {Object} item - Queue item with { index, text, element }
   */
  _refreshItemText(item) {
    if (!item || !item.element) return;
    if (item.element.getAttribute('data-translated') !== 'true') return;
    const clone = item.element.cloneNode(true);
    clone.querySelectorAll('.para-num').forEach(n => n.remove());
    const freshText = (clone.textContent || '').trim();
    if (freshText) {
      item.text = freshText;
    }
  }

  /**
   * Wait for the data-translated attribute to appear on the element.
   * @param {Object} item - Queue item with .element
   * @param {AbortSignal|null} signal
   * @param {number} timeout - Max milliseconds to wait
   * @returns {Promise<boolean>} true if attribute appeared, false on timeout/abort
   */
  _waitForDataTranslated(item, signal, timeout) {
    return new Promise((resolve) => {
      if (signal && signal.aborted) { resolve(false); return; }
      if (item.element.getAttribute('data-translated') === 'true') { resolve(true); return; }

      let observer = null;
      let timeoutId = null;
      let pollId = null;
      let abortHandler = null;

      const cleanup = () => {
        if (observer) { observer.disconnect(); observer = null; }
        if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
        if (pollId) { clearInterval(pollId); pollId = null; }
        if (abortHandler && signal) { signal.removeEventListener('abort', abortHandler); abortHandler = null; }
      };

      if (signal) {
        abortHandler = () => { cleanup(); resolve(false); };
        signal.addEventListener('abort', abortHandler);
      }

      timeoutId = setTimeout(() => { cleanup(); resolve(false); }, timeout);

      observer = new MutationObserver(() => {
        if (item.element.getAttribute('data-translated') === 'true') {
          cleanup(); resolve(true);
        }
      });
      observer.observe(item.element, { attributes: true, attributeFilter: ['data-translated'] });

      pollId = setInterval(() => {
        if (item.element.getAttribute('data-translated') === 'true') {
          cleanup(); resolve(true);
        }
      }, 500);
    });
  }

  /**
   * Speak the current paragraph.
   * Async to support waiting for translation on the translation panel.
   */
  async _speakCurrent() {
    if (this._currentIndex >= this._paragraphs.length) {
      // Reached the end
      this._currentIndex = 0;
      this._paragraphs = [];
      this._setState('idle');
      this._clearHighlight();
      return;
    }

    // Fire reading progress based on paragraph position (decoupled from AudioBufferStore)
    if (this._paragraphs.length > 0 && this._onProgressChange) {
      this._onProgressChange(Math.floor((this._currentIndex + 1) / this._paragraphs.length * 100));
    }

    const item = this._paragraphs[this._currentIndex];
    const panel = this._getActivePanel();

    // Highlight and scroll
    this._tracker.highlight(panel, item.index);
    this._tracker.scrollToVisible(panel, item.index);

    // If on translation panel, ensure paragraph is translated before reading
    if (this._settings.panel === 'translation') {
      // Create abort controller if not already present (for free mode)
      if (!this._abortController) {
        this._abortController = new AbortController();
      }
      await this._ensureTranslated(this._currentIndex);
      // Check if we were stopped/paused during translation wait
      if (this._state !== 'playing') return;
    }

    // Fire-and-forget: proactively trigger translation for upcoming paragraphs
    this._triggerTranslationLookahead();

    if (this._settings.mode === 'free') {
      this._speakFree(item.text);
    } else {
      this._speakPro(item.text);
    }
  }

  /**
   * Proactively trigger translation for upcoming paragraphs (fire-and-forget).
   * When on the translation panel, triggers translation for paragraphs N+1 through
   * N+24 (2 full chunks ahead, where N is the current paragraph data-idx).
   * Does not await — this is a background pre-translation to reduce wait time.
   * Idempotent: paragraphs already translated or in-flight are skipped by the callback.
   */
  _triggerTranslationLookahead() {
    // Only run on translation panel with a translation callback available
    if (this._settings.panel !== 'translation' || !this._onTranslationNeeded) return;

    const currentItem = this._paragraphs[this._currentIndex];
    if (!currentItem) return;

    const startIdx = currentItem.index + 1;
    // Cap at the maximum paragraph data-idx in the queue
    const lastItem = this._paragraphs[this._paragraphs.length - 1];
    const maxIdx = lastItem ? lastItem.index : startIdx;
    const endIdx = Math.min(startIdx + this._TRANSLATION_LOOKAHEAD - 1, maxIdx);

    // Only trigger if there's a valid range ahead
    if (startIdx > endIdx) return;

    // Fire-and-forget — no await, catch to prevent unhandled rejection
    const result = this._onTranslationNeeded(startIdx, endIdx);
    if (result && typeof result.catch === 'function') {
      result.catch(() => {});
    }
  }

  /**
   * Speak using the FREE engine (Web Speech API).
   */
  _speakFree(text) {
    const langCode = this._getActiveLang();
    const voices = this._freeEngine.getVoicesForLang(langCode);

    // Find the selected voice or use the first available
    let voice = null;
    if (this._settings.voiceURI) {
      voice = voices.find(v => v.voiceURI === this._settings.voiceURI) || null;
    }
    if (!voice && voices.length > 0) {
      voice = voices[0];
    }

    this._freeEngine.speak(text, {
      voice,
      rate: this._settings.rate,
      pitch: this._settings.pitch,
      onEnd: () => {
        this._advanceToNext();
      },
      onError: (err) => {
        console.warn('[TTS] Free engine error, skipping paragraph:', err.message);
        this._advanceToNext();
      }
    });
  }

  /**
   * Speak using the PRO engine (OpenRouter) with lookahead prefetch.
   */
  async _speakPro(text) {
    this._abortController = new AbortController();

    try {
      // Check if this paragraph's audio is already in the prefetch cache
      let audioBuffer;
      let rawMp3Bytes;
      const cacheKey = this._currentIndex;
      const item = this._paragraphs[this._currentIndex];
      if (this._prefetchCache.has(cacheKey)) {
        const cached = await this._prefetchCache.get(cacheKey);
        this._prefetchCache.delete(cacheKey);
        if (cached) {
          audioBuffer = cached.audioBuffer;
          rawMp3Bytes = cached.rawMp3Bytes;
        }
      }

      if (!audioBuffer) {
        // Not cached or cache entry was null (failed prefetch) — synthesize now
        const result = await this._proEngine.synthesize(text, {
          model: this._settings.ttsModel || 'canopylabs/orpheus-3b-0.1-ft',
          voice: this._settings.ttsVoice,
          speed: this._settings.rate,
          lang: this._getActiveLang(),
          signal: this._abortController.signal
        });
        audioBuffer = result.audioBuffer;
        rawMp3Bytes = result.rawMp3Bytes;
      }

      // Store raw audio bytes in the buffer store for download
      if (rawMp3Bytes) {
        this._bufferStore.add(item.index, rawMp3Bytes);
      }

      // Check if we were stopped while synthesizing
      if (this._state !== 'playing') return;

      // Kick off prefetch for upcoming paragraphs while this one plays
      this._prefetchAhead();

      await this._proEngine.play(audioBuffer);

      // Check if we were stopped while playing
      if (this._state === 'playing') {
        this._advanceToNext();
      }
    } catch (err) {
      if (err.name === 'AbortError') return; // User stopped, ignore

      // Determine if this is a fatal error (HTTP/network) or a transient one (audio decode)
      const isFatalError = err.message &&
        (err.message.includes('OpenRouter TTS error') ||
         err.message.includes('API key not configured') ||
         err.message.includes('Failed to fetch') ||
         err.message.includes('NetworkError') ||
         err.message.includes('Network request failed'));

      if (isFatalError) {
        // HTTP errors and network failures: stop playback, notify user
        console.error('[TTS] Pro engine fatal error:', err.message);
        this._cancelAll();
        this._currentIndex = 0;
        this._paragraphs = [];
        this._bufferStore.clear();
        this._setState('idle');
        this._clearHighlight();
        if (this._onError) this._onError(err);
      } else {
        // Audio decode failure or other transient error: skip paragraph
        console.warn('[TTS] Pro engine error, skipping paragraph:', err.message);
        if (this._state === 'playing') {
          this._advanceToNext();
        }
      }
    }
  }

  /**
   * Pre-fetch audio for the next N paragraphs into the cache.
   * Runs in the background while the current paragraph plays.
   */
  _prefetchAhead() {
    // Create a shared abort controller for all prefetch requests
    if (!this._prefetchAbort) {
      this._prefetchAbort = new AbortController();
    }

    for (let offset = 1; offset <= this._LOOKAHEAD; offset++) {
      const idx = this._currentIndex + offset;
      if (idx >= this._paragraphs.length) break;
      if (this._prefetchCache.has(idx)) continue; // already fetching/fetched

      const item = this._paragraphs[idx];
      const promise = this._proEngine.synthesize(item.text, {
        model: this._settings.ttsModel || 'canopylabs/orpheus-3b-0.1-ft',
        voice: this._settings.ttsVoice,
        speed: this._settings.rate,
        lang: this._getActiveLang(),
        signal: this._prefetchAbort.signal
      }).catch(err => {
        // Remove failed entries from cache so they get re-tried on demand
        this._prefetchCache.delete(idx);
        return null;
      });

      this._prefetchCache.set(idx, promise);
    }
  }

  /**
   * Clear the prefetch cache and abort pending prefetch requests.
   */
  _clearPrefetchCache() {
    if (this._prefetchAbort) {
      this._prefetchAbort.abort();
      this._prefetchAbort = null;
    }
    this._prefetchCache.clear();
  }

  /**
   * Advance to the next paragraph in the queue.
   */
  _advanceToNext() {
    this._currentIndex++;
    if (this._currentIndex >= this._paragraphs.length) {
      // Reached the end of the chapter — fire 100% progress before transitioning to idle
      if (this._paragraphs.length > 0 && this._onProgressChange) {
        this._onProgressChange(100);
      }
      this._bufferStore.forceComplete();
      this._currentIndex = 0;
      this._paragraphs = [];
      this._setState('idle');
      this._clearHighlight();
    } else {
      this._speakCurrent();
    }
  }

  /**
   * Resume from paused state.
   */
  _resume() {
    if (this._settings.mode === 'free') {
      this._freeEngine.resume();
    } else {
      this._proEngine.resume();
    }
    this._setState('playing');
  }

  /**
   * Cancel all pending speech/audio.
   */
  _cancelAll() {
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
    this._freeEngine.cancel();
    this._proEngine.stop();
    this._clearPrefetchCache();
  }

  /**
   * Clear all highlights from the active panel.
   */
  _clearHighlight() {
    const panel = this._getActivePanel();
    if (panel) {
      this._tracker.clear(panel);
    }
  }

  /**
   * Get the language code for the active panel.
   * Reads from the stored settings.
   * @returns {string}
   */
  _getActiveLang() {
    const stored = loadSettings();
    if (this._settings.panel === 'translation') {
      return stored.targetLang || stored.translationLang || 'en';
    }
    return stored.sourceLang || stored.bookLang || 'en';
  }

  /**
   * Update internal state and notify listener.
   * @param {'idle'|'playing'|'paused'} newState
   */
  _setState(newState) {
    this._state = newState;
    if (this._onStateChange) {
      this._onStateChange(this.getState());
    }
  }
}

// ---------------------------------------------------------------------------
// Download filename utility
// ---------------------------------------------------------------------------

/**
 * Generate download filename: {sanitized-book-title}_chapter{N}.mp3
 * @param {string} bookTitle - Raw book title
 * @param {number} chapterIndex - 1-based chapter index
 * @returns {string}
 */
export function makeDownloadFilename(bookTitle, chapterIndex) {
  // Replace characters not allowed in filenames with underscores
  let sanitized = bookTitle.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
  // Collapse multiple underscores
  sanitized = sanitized.replace(/_+/g, '_');
  // Trim leading/trailing whitespace and underscores
  sanitized = sanitized.trim();
  // Truncate to 100 characters
  if (sanitized.length > 100) sanitized = sanitized.substring(0, 100);
  return `${sanitized}_chapter${chapterIndex}.mp3`;
}

// ---------------------------------------------------------------------------
// AudioBufferStore
// ---------------------------------------------------------------------------

/**
 * Accumulates raw MP3 byte arrays for download.
 * Maintains paragraph ordering by data-idx.
 */
export class AudioBufferStore {
  constructor() {
    this._store = new Map(); // Map<paragraphIndex, Uint8Array>
    this._totalParagraphs = 0;
    this._onProgress = null; // callback(progressPercent)
  }

  /**
   * Reset the store for a new session.
   * @param {number} totalParagraphs - Total speakable paragraphs in the chapter
   * @param {Function} [onProgress] - Called with integer percent on each addition
   */
  init(totalParagraphs, onProgress) {
    this._store.clear();
    this._totalParagraphs = totalParagraphs;
    this._onProgress = onProgress || null;
  }

  /**
   * Add raw MP3 bytes for a paragraph.
   * @param {number} paragraphIndex - The data-idx of the paragraph
   * @param {Uint8Array} rawBytes - Raw MP3 byte array
   */
  add(paragraphIndex, rawBytes) {
    this._store.set(paragraphIndex, rawBytes);
    if (this._onProgress) {
      this._onProgress(this.getProgress());
    }
  }

  /**
   * Get current transcoding progress as integer percentage (floored).
   * @returns {number} 0–100
   */
  getProgress() {
    if (this._totalParagraphs === 0) return 0;
    return Math.floor((this._store.size / this._totalParagraphs) * 100);
  }

  /**
   * Whether any audio has been accumulated.
   * @returns {boolean}
   */
  hasData() {
    return this._store.size > 0;
  }

  /**
   * Force progress to 100% when playback ends naturally with stored data.
   * Gated on hasData() so Gemini sessions (which never store bytes) are unaffected.
   */
  forceComplete() {
    if (this.hasData()) {
      if (this._onProgress) {
        this._onProgress(100);
      }
    }
  }

  /**
   * Assemble all stored bytes into a single Blob in paragraph order.
   * Paragraphs are sorted by their index (data-idx order).
   * @returns {Blob} MP3 blob
   */
  assembleBlob() {
    const sorted = [...this._store.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, bytes]) => bytes);
    return new Blob(sorted, { type: 'audio/mpeg' });
  }

  /**
   * Assemble all stored PCM bytes into a WAV blob.
   * PCM is assumed to be 16-bit signed LE mono at 24000 Hz (Gemini format).
   * @returns {Blob} WAV blob
   */
  assembleWavBlob() {
    const sorted = [...this._store.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, bytes]) => bytes);
    const totalLen = sorted.reduce((sum, b) => sum + b.byteLength, 0);
    const sampleRate = 24000;
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const headerSize = 44;
    const buffer = new ArrayBuffer(headerSize + totalLen);
    const view = new DataView(buffer);
    // RIFF header
    const writeStr = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + totalLen, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true); // subchunk1 size
    view.setUint16(20, 1, true); // PCM format
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    writeStr(36, 'data');
    view.setUint32(40, totalLen, true);
    // PCM data
    const output = new Uint8Array(buffer);
    let offset = headerSize;
    for (const chunk of sorted) {
      output.set(new Uint8Array(chunk.buffer || chunk), offset);
      offset += chunk.byteLength;
    }
    return new Blob([buffer], { type: 'audio/wav' });
  }

  /** Clear all stored data and reset progress. */
  clear() {
    this._store.clear();
    this._totalParagraphs = 0;
  }
}

// ---------------------------------------------------------------------------
// Public API — singleton export
// ---------------------------------------------------------------------------

const ttsController = new TTSController();
export default ttsController;
