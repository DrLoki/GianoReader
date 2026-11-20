// Progress card for PDF work (ported from PDF X-Ray, src/main.js):
// opening the document → page extraction (pdf.js) → layout analysis (Rust).
//
// The logic is DOM-free: `paint(view)` receives what to show and the caller
// draws it. Times, timers and strings are injected so the module can be tested.
//
// A run opened explicitly with `begin()` (opening a file) shows at once. A run
// started implicitly by `extract()` (changing chapter) shows only after
// `showDelay` ms, so pages already in the cache do not make the card flash.

/** Share of the bar given to each phase of a run. */
export const PHASE_WEIGHT = { prepare: 0.04, extract: 0.86, analyze: 0.10 };

/** "<1 s", "12 s", "3 min 05 s"; '' for invalid values. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 1) return '<1 s';
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${String(s % 60).padStart(2, '0')} s`;
}

export class PdfProgress {
  /**
   * @param {object} deps
   * @param {(view: object) => void} deps.paint view: { visible, phase, detail, eta, fraction, busy, state }
   * @param {(key: string, vars?: object) => string} deps.t UI strings
   */
  constructor({ paint, t, now = () => performance.now(), timers = globalThis, showDelay = 400, hideAfter = 2500, failHideAfter = 6000 }) {
    this._paint = paint;
    this._t = t;
    this._now = now;
    this._timers = timers;
    this.showDelay = showDelay;
    this.hideAfter = hideAfter;
    this.failHideAfter = failHideAfter;
    this.analyzeMsPerPage = 6; // learnt from the analyses of this session
    this.analyzeOverhead = 250;
    this.active = false;
    this._visible = false;
    this._ticker = null;
    this._hideTimer = null;
    this._showTimer = null;
    this._view = null;
  }

  estimateAnalysisMs(pages) {
    return this.analyzeOverhead + pages * this.analyzeMsPerPage;
  }

  /** Starts a run. `immediate` false: show only if it lasts more than `showDelay`. */
  begin({ immediate = true } = {}) {
    this._stopTicker();
    this._clear('_hideTimer');
    this._clear('_showTimer');
    this.active = true;
    this.start = this.phaseStart = this._now();
    this.extractRate = null;
    this._visible = immediate || this._visible;
    if (!this._visible) {
      this._showTimer = this._timers.setTimeout(() => {
        this._showTimer = null;
        if (this.active) { this._visible = true; this._render(); }
      }, this.showDelay);
    }
    this._set({ phase: this._t('pdfProgressOpening'), detail: '', eta: '', fraction: 0, busy: true });
  }

  /** Reading of the document by pdf.js (bytes). */
  opening(loaded, total) {
    if (!this.active) return;
    const f = total > 0 ? Math.min(1, loaded / total) : 0;
    const mb = (n) => (n / 1_048_576).toFixed(1);
    const detail = total > 0 ? `${mb(loaded)} / ${mb(total)} MB` : '';
    this._set({ phase: this._t('pdfProgressOpening'), detail, eta: '', fraction: PHASE_WEIGHT.prepare * f, busy: true });
  }

  /** `done` pages of `total` extracted, the last one being `pageNum`. */
  extract(done, total, pageNum) {
    if (!this.active) this.begin({ immediate: false });
    const now = this._now();
    const detail = this._t('pdfProgressPage', { page: pageNum, done, total });
    if (done === 0) {
      this.phaseStart = now;
      this._set({ phase: this._t('pdfProgressExtracting'), detail, eta: this._t('pdfProgressEstimating'), fraction: PHASE_WEIGHT.prepare, busy: true });
      return;
    }
    // per-page time: overall average, smoothed so one slow page does not make the ETA jump
    const avg = (now - this.phaseStart) / done;
    this.extractRate = this.extractRate === null ? avg : this.extractRate * 0.7 + avg * 0.3;
    const remaining = (total - done) * this.extractRate + this.estimateAnalysisMs(total);
    const f = PHASE_WEIGHT.prepare + PHASE_WEIGHT.extract * (done / total);
    const eta = done < Math.min(3, total)
      ? this._t('pdfProgressEstimating')
      : this._t('pdfProgressLeft', { time: formatDuration(remaining) });
    this._set({ phase: this._t('pdfProgressExtracting'), detail, eta, fraction: f, busy: false });
  }

  /** Layout analysis: a single Rust call, shown as an estimate plus the elapsed time. */
  analyze(pages) {
    if (!this.active) this.begin({ immediate: false });
    this._stopTicker();
    const t0 = this._now();
    this._analysis = { t0, pages };
    const estimate = this.estimateAnalysisMs(pages);
    const base = PHASE_WEIGHT.prepare + PHASE_WEIGHT.extract;
    const tick = () => {
      const elapsed = this._now() - t0;
      // approaches the end of the phase asymptotically (63 % at the estimate):
      // the bar keeps moving if the estimate is optimistic, never 100 % early
      const f = base + PHASE_WEIGHT.analyze * 0.97 * (1 - Math.exp(-elapsed / estimate));
      const left = estimate - elapsed;
      const eta = left > 500 ? this._t('pdfProgressLeft', { time: formatDuration(left) }) : this._t('pdfProgressAlmost');
      const detail = this._t('pdfProgressPages', { pages, time: formatDuration(elapsed) || '<1 s' });
      this._set({ phase: this._t('pdfProgressAnalyzing'), detail, eta, fraction: f, busy: true });
    };
    tick();
    this._ticker = this._timers.setInterval(tick, 250);
  }

  /** End of the run: shows the summary, then fades out. */
  done(summary = '') {
    if (!this.active) return;
    this._stopTicker();
    this._clear('_showTimer');
    if (this._analysis) {
      // learn the analysis speed for the next estimates
      const { t0, pages } = this._analysis;
      const ms = this._now() - t0;
      if (pages > 0) this.analyzeMsPerPage = Math.max(0.5, (ms - this.analyzeOverhead) / pages);
      this._analysis = null;
    }
    this.active = false;
    if (!this._visible) return; // quick run: never shown
    const total = this._now() - this.start;
    this._set({ phase: this._t('pdfProgressDone'), detail: summary, eta: this._t('pdfProgressIn', { time: formatDuration(total) }), fraction: 1, busy: false, state: 'done' });
    this._hideTimer = this._timers.setTimeout(() => this.hide(), this.hideAfter);
  }

  /** Error: the bar turns red with the message, then hides. */
  fail(message) {
    this._stopTicker();
    this._clear('_showTimer');
    this._clear('_hideTimer');
    this.active = false;
    this._analysis = null;
    this._visible = true;
    this._set({ phase: this._t('pdfProgressFailed'), detail: String(message || ''), eta: '', fraction: 1, busy: false, state: 'error' });
    this._hideTimer = this._timers.setTimeout(() => this.hide(), this.failHideAfter);
  }

  /** Hides the card at once (e.g. the work was cancelled). */
  hide() {
    this._stopTicker();
    this._clear('_showTimer');
    this._clear('_hideTimer');
    this.active = false;
    this._analysis = null;
    this._visible = false;
    this._view = { ...(this._view || {}), visible: false };
    this._paint(this._view);
  }

  _set(view) {
    this._view = { state: 'run', ...view };
    this._render();
  }

  _render() {
    if (!this._visible || !this._view) return;
    this._paint({ ...this._view, visible: true });
  }

  _stopTicker() {
    if (this._ticker) this._timers.clearInterval(this._ticker);
    this._ticker = null;
  }

  _clear(name) {
    if (this[name]) this._timers.clearTimeout(this[name]);
    this[name] = null;
  }
}
