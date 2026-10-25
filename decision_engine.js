/**
 * SEED SORTER — PHASE A: PURE DECISION ENGINE
 * ============================================================================
 * All actuation/inference decisions live here, completely isolated from:
 *   - DOM manipulation
 *   - Arduino / WebSerial
 *   - Audio synthesis
 *   - Canvas / particle physics
 *   - Timers (setTimeout / setInterval)
 *
 * Run tests with: node test_decision.js
 * ============================================================================
 */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const REQUIRED_LABELS        = ['pepper', 'papaya'];
const BG_CLASS_KEYWORDS      = ['background', 'empty', 'none', 'idle', 'not_a_seed', 'other'];

// Phase A defaults (all configurable by the caller)
const DEFAULT_THRESHOLD          = 0.90;   // Minimum winning-class probability
const DEFAULT_MARGIN             = 0.20;   // Minimum lead over the losing class
const DEFAULT_CONFIRM_FRAMES     = 5;      // Consecutive valid frames required before actuation
const DEFAULT_REARM_EMPTY_FRAMES = 10;     // Consecutive empty frames required to rearm latch

// ─── Model Validation ─────────────────────────────────────────────────────────

/**
 * Validate that a loaded Teachable Machine model object exposes the expected
 * class labels and output unit count.
 *
 * Returns { ok: true, labels, classCount } on success.
 * Returns { ok: false, reason } on failure.
 *
 * NOTE: This function does NOT throw; the caller decides whether to abort.
 *
 * @param {object|null|undefined} modelObj  – The tmImage.load() result
 * @returns {{ ok: boolean, labels?: string[], classCount?: number, reason?: string }}
 */
function validateModel(modelObj) {
  if (!modelObj || typeof modelObj !== 'object') {
    return { ok: false, reason: 'Model is null or not an object (load may have failed).' };
  }

  // Teachable Machine exposes getClassLabels() on the model object.
  // Fallback: some builds expose getTotalClasses() and getClassNames().
  let labels = null;
  if (typeof modelObj.getClassLabels === 'function') {
    labels = modelObj.getClassLabels();
  } else if (typeof modelObj.getClassNames === 'function') {
    labels = modelObj.getClassNames();
  } else if (Array.isArray(modelObj.labels)) {
    labels = modelObj.labels;
  }

  if (!Array.isArray(labels) || labels.length === 0) {
    return { ok: false, reason: 'Cannot determine class labels from the loaded model object.' };
  }

  const labelsLower = labels.map(l => String(l).toLowerCase());

  for (const required of REQUIRED_LABELS) {
    if (!labelsLower.some(l => l.includes(required))) {
      return {
        ok: false,
        reason: `Required label "${required}" not found in model labels: [${labels.join(', ')}].`
      };
    }
  }

  return { ok: true, labels, classCount: labels.length };
}

// ─── Prediction Parsing ───────────────────────────────────────────────────────

/**
 * Parse a raw predictions array (as returned by tmImage model.predict()) into
 * named probabilities.
 *
 * A predictions array looks like:
 *   [ { className: 'pepper', probability: 0.97 }, { className: 'papaya', probability: 0.03 } ]
 *
 * Returns:
 *   {
 *     pepperProb:     number (0–1),
 *     papayaProb:     number (0–1),
 *     backgroundProb: number (0–1),
 *     hasBgClass:     boolean,
 *     valid:          boolean,   // false if any probability is non-finite / missing
 *     invalidReason:  string|null
 *   }
 *
 * @param {Array} predictions
 * @returns {object}
 */
function parsePredictions(predictions) {
  const blank = {
    pepperProb: 0, papayaProb: 0, backgroundProb: 0,
    hasBgClass: false, valid: false, invalidReason: null
  };

  if (!Array.isArray(predictions) || predictions.length === 0) {
    return { ...blank, invalidReason: 'Predictions is empty or not an array.' };
  }

  let pepperProb = null, papayaProb = null, backgroundProb = 0;
  let hasBgClass = false;

  for (const p of predictions) {
    if (!p || typeof p.className !== 'string' || typeof p.probability !== 'number') {
      return { ...blank, invalidReason: 'Prediction entry is malformed (missing className or probability).' };
    }
    if (!Number.isFinite(p.probability) || p.probability < 0 || p.probability > 1) {
      return { ...blank, invalidReason: `Non-finite or out-of-range probability (${p.probability}) for class "${p.className}".` };
    }
    const name = p.className.toLowerCase();
    if (name.includes('pepper')) {
      pepperProb = p.probability;
    } else if (name.includes('papaya')) {
      papayaProb = p.probability;
    } else if (BG_CLASS_KEYWORDS.some(kw => name.includes(kw))) {
      backgroundProb = p.probability;
      hasBgClass = true;
    }
  }

  if (pepperProb === null || papayaProb === null) {
    return {
      ...blank,
      invalidReason: `Required class(es) missing from predictions. Found: [${predictions.map(p => p.className).join(', ')}].`
    };
  }

  return {
    pepperProb,
    papayaProb,
    backgroundProb,
    hasBgClass,
    valid: true,
    invalidReason: null
  };
}

// ─── Core Decision Function ───────────────────────────────────────────────────

/**
 * Classify a single inference result as one of:
 *   'pepper'       — confident pepper detection
 *   'papaya'       — confident papaya detection
 *   'background'   — background/not-a-seed class dominant (only when hasBgClass=true)
 *   'uncertain'    — probabilities valid but no class meets the confidence/margin bar
 *   'invalid'      — predictions are malformed or required fields are missing
 *
 * This function is PURE:
 *   • No DOM access
 *   • No Arduino / serial commands
 *   • No timers, audio, or animations
 *   • No global state read or written
 *
 * @param {Array}   predictions           – Raw tmImage predict() output
 * @param {object}  opts                  – Configuration overrides
 * @param {number}  [opts.threshold]      – Minimum winning probability (default 0.90)
 * @param {number}  [opts.margin]         – Minimum lead over runner-up (default 0.20)
 * @returns {{ decision: string, reason: string, pepperProb: number, papayaProb: number, backgroundProb: number }}
 */
function classifyPrediction(predictions, opts = {}) {
  const threshold = (typeof opts.threshold === 'number') ? opts.threshold : DEFAULT_THRESHOLD;
  const margin    = (typeof opts.margin    === 'number') ? opts.margin    : DEFAULT_MARGIN;

  const parsed = parsePredictions(predictions);

  if (!parsed.valid) {
    return {
      decision: 'invalid',
      reason: parsed.invalidReason,
      pepperProb: 0, papayaProb: 0, backgroundProb: 0
    };
  }

  const { pepperProb, papayaProb, backgroundProb, hasBgClass } = parsed;

  // Background-dominant: only applies when the model actually has a bg class
  if (hasBgClass && backgroundProb > 0.35) {
    return {
      decision: 'background',
      reason: `Background class probability ${(backgroundProb * 100).toFixed(1)}% > 35% gate.`,
      pepperProb, papayaProb, backgroundProb
    };
  }

  // Pepper wins
  if (pepperProb >= threshold && (pepperProb - papayaProb) >= margin) {
    return {
      decision: 'pepper',
      reason: `Pepper ${(pepperProb * 100).toFixed(1)}% ≥ threshold ${(threshold * 100).toFixed(0)}%, margin ${((pepperProb - papayaProb) * 100).toFixed(1)}%.`,
      pepperProb, papayaProb, backgroundProb
    };
  }

  // Papaya wins
  if (papayaProb >= threshold && (papayaProb - pepperProb) >= margin) {
    return {
      decision: 'papaya',
      reason: `Papaya ${(papayaProb * 100).toFixed(1)}% ≥ threshold ${(threshold * 100).toFixed(0)}%, margin ${((papayaProb - pepperProb) * 100).toFixed(1)}%.`,
      pepperProb, papayaProb, backgroundProb
    };
  }

  return {
    decision: 'uncertain',
    reason: `No class meets threshold=${(threshold * 100).toFixed(0)}% + margin=${(margin * 100).toFixed(0)}%. Pepper=${(pepperProb * 100).toFixed(1)}% Papaya=${(papayaProb * 100).toFixed(1)}%.`,
    pepperProb, papayaProb, backgroundProb
  };
}

// ─── Per-Insertion Latch + Multi-Frame Confirmation State Machine ──────────────

/**
 * SortLatch: tracks per-insertion multi-frame confirmation and the one-sort-per-seed
 * latch so that:
 *   1. A sorting action only fires after CONFIRM_FRAMES consecutive agreeing frames.
 *   2. Once a sort has fired for an insertion, no further sort fires until the optical
 *      gate observes REARM_EMPTY_FRAMES consecutive stable empty frames.
 *   3. The latch is never cleared by warmup, camera relocation, or transient failures.
 *
 * Usage (caller drives the state machine frame by frame):
 *
 *   const latch = new SortLatch();
 *   // Each frame:
 *   const result = latch.update(decision, presenceIsClean, gateActive);
 *   // result.action is 'pepper' | 'papaya' | null
 */
class SortLatch {
  /**
   * @param {object} [opts]
   * @param {number} [opts.confirmFrames]      – Consecutive qualifying frames (default 5)
   * @param {number} [opts.rearmEmptyFrames]   – Consecutive empty frames to rearm (default 10)
   */
  constructor(opts = {}) {
    this.confirmFrames    = (typeof opts.confirmFrames    === 'number') ? opts.confirmFrames    : DEFAULT_CONFIRM_FRAMES;
    this.rearmEmptyFrames = (typeof opts.rearmEmptyFrames === 'number') ? opts.rearmEmptyFrames : DEFAULT_REARM_EMPTY_FRAMES;

    this._reset();
  }

  _reset() {
    this.candidateClass   = null;   // 'pepper' | 'papaya' | null
    this.confirmCount     = 0;      // consecutive frames agreeing on candidateClass
    this.latched          = false;  // true: a sort has been actioned; awaiting rearm
    this.emptyFrameCount  = 0;      // consecutive stable empty frames since latch set
  }

  /**
   * Feed one frame result into the state machine.
   *
   * @param {string}  decision       – Output of classifyPrediction(): 'pepper'|'papaya'|'uncertain'|'background'|'invalid'
   * @param {boolean} presenceClean  – true = optical gate says chamber is genuinely empty (not rejected object, not warming, not moved)
   * @param {boolean} gateActive     – true = optical gate is enabled
   * @returns {{ action: string|null, confirmCount: number, candidateClass: string|null, latched: boolean, emptyFrameCount: number }}
   */
  update(decision, presenceClean, gateActive) {
    const isSeedDecision = (decision === 'pepper' || decision === 'papaya');
    const isEmptyFrame   = (presenceClean === true);  // strictly true = genuinely empty confirmed

    // ── Rearm logic ──
    // Count empty frames whenever latched; rearm when threshold is met.
    if (this.latched) {
      if (isEmptyFrame) {
        this.emptyFrameCount++;
        if (this.emptyFrameCount >= this.rearmEmptyFrames) {
          // Rearm: ready to detect the next seed insertion
          this.latched         = false;
          this.emptyFrameCount = 0;
          this.candidateClass  = null;
          this.confirmCount    = 0;
        }
      } else {
        // Non-empty: keep latch armed, but don't count empty frames continuously
        // (reset so that partial empty sequences don't accidentally rearm)
        this.emptyFrameCount = 0;
      }
      return this._status(null);
    }

    // ── Confirmation accumulation ──
    if (!isSeedDecision) {
      // Invalid / uncertain / background / gate rejection resets candidate
      this.candidateClass = null;
      this.confirmCount   = 0;
      return this._status(null);
    }

    if (decision === this.candidateClass) {
      this.confirmCount++;
    } else {
      // New candidate class (or first seed frame); start fresh
      this.candidateClass = decision;
      this.confirmCount   = 1;
    }

    if (this.confirmCount >= this.confirmFrames) {
      // Enough consecutive frames — fire the action and set latch
      this.latched         = true;
      this.emptyFrameCount = 0;
      const fired          = this.candidateClass;
      this.candidateClass  = null;
      this.confirmCount    = 0;
      return this._status(fired);
    }

    return this._status(null);
  }

  /** Return a status snapshot without exposing internals directly */
  _status(action) {
    return {
      action,
      confirmCount:    this.confirmCount,
      candidateClass:  this.candidateClass,
      latched:         this.latched,
      emptyFrameCount: this.emptyFrameCount
    };
  }

  /** Manual reset (e.g. when camera disconnects or gate is re-enabled) */
  reset() {
    this._reset();
  }
}

// ─── Export ───────────────────────────────────────────────────────────────────
// Supports both Node.js (require) and browser <script> (window global).

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    validateModel,
    parsePredictions,
    classifyPrediction,
    SortLatch,
    REQUIRED_LABELS,
    BG_CLASS_KEYWORDS,
    DEFAULT_THRESHOLD,
    DEFAULT_MARGIN,
    DEFAULT_CONFIRM_FRAMES,
    DEFAULT_REARM_EMPTY_FRAMES
  };
}
