/**
 * SEED SORTER — PHASE B: PURE DECISION ENGINE
 * ============================================================================
 * Supports both:
 *   - Genuine 3-class models: ['pepper_seed', 'papaya_seed', 'other_background']
 *   - Legacy 2-class models:  ['pepper', 'papaya']
 *
 * All actuation/inference decisions live here, completely isolated from:
 *   - DOM manipulation
 *   - Arduino / WebSerial
 *   - Audio synthesis
 *   - Canvas / particle physics
 *   - Timers (setTimeout / setInterval)
 * ============================================================================
 */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const REQUIRED_LABELS        = ['pepper', 'papaya'];
const BG_CLASS_KEYWORDS      = ['background', 'empty', 'none', 'idle', 'not_a_seed', 'other'];

// Phase A & B defaults (all configurable by the caller)
const DEFAULT_THRESHOLD          = 0.90;   // Minimum winning-class probability
const DEFAULT_MARGIN             = 0.20;   // Minimum lead over the runner-up class
const DEFAULT_BG_THRESHOLD       = 0.35;   // Background probability gate
const DEFAULT_CONFIRM_FRAMES     = 5;      // Consecutive valid frames required before actuation
const DEFAULT_REARM_EMPTY_FRAMES = 10;     // Consecutive empty frames required to rearm latch

// ─── Model Validation ─────────────────────────────────────────────────────────

/**
 * Validate that a loaded Teachable Machine model object exposes the expected
 * class labels and output unit count.
 *
 * Supports both:
 *   - 2-class models (pepper, papaya)
 *   - 3-class models (pepper_seed, papaya_seed, other_background)
 *
 * @param {object|null|undefined} modelObj        – The tmImage.load() result
 * @param {object}               [opts]
 * @param {boolean}              [opts.requireBg] – If true, enforces presence of background class
 * @returns {{ ok: boolean, labels?: string[], classCount?: number, hasBgClass?: boolean, isThreeClass?: boolean, reason?: string }}
 */
function validateModel(modelObj, opts = {}) {
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

  // Check required seed classes
  for (const required of REQUIRED_LABELS) {
    if (!labelsLower.some(l => l.includes(required))) {
      return {
        ok: false,
        reason: `Required label "${required}" not found in model labels: [${labels.join(', ')}].`
      };
    }
  }

  const hasBgClass = labelsLower.some(l => BG_CLASS_KEYWORDS.some(kw => l.includes(kw)));
  const isThreeClass = (labels.length >= 3 && hasBgClass);

  if (opts.requireBg && !hasBgClass) {
    return {
      ok: false,
      reason: `3-class model requires a background/other negative class label, but none was found in: [${labels.join(', ')}].`
    };
  }

  return {
    ok: true,
    labels,
    classCount: labels.length,
    hasBgClass,
    isThreeClass
  };
}

// ─── Prediction Parsing ───────────────────────────────────────────────────────

/**
 * Parse a raw predictions array (as returned by tmImage model.predict()) into
 * named probabilities.
 *
 * Supports 2-class, 3-class, and N-class models safely.
 *
 * @param {Array} predictions
 * @returns {object}
 */
function parsePredictions(predictions) {
  const blank = {
    pepperProb: 0, papayaProb: 0, backgroundProb: 0,
    hasBgClass: false, rawMap: {}, valid: false, invalidReason: null
  };

  if (!Array.isArray(predictions) || predictions.length === 0) {
    return { ...blank, invalidReason: 'Predictions is empty or not an array.' };
  }

  let pepperProb = null, papayaProb = null, backgroundProb = 0;
  let hasBgClass = false;
  const rawMap = {};

  for (const p of predictions) {
    if (!p || typeof p.className !== 'string' || typeof p.probability !== 'number') {
      return { ...blank, invalidReason: 'Prediction entry is malformed (missing className or probability).' };
    }
    if (!Number.isFinite(p.probability) || p.probability < 0 || p.probability > 1) {
      return { ...blank, invalidReason: `Non-finite or out-of-range probability (${p.probability}) for class "${p.className}".` };
    }

    rawMap[p.className] = p.probability;
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
      invalidReason: `Required seed class(es) missing from predictions. Found: [${predictions.map(p => p.className).join(', ')}].`
    };
  }

  return {
    pepperProb,
    papayaProb,
    backgroundProb,
    hasBgClass,
    rawMap,
    valid: true,
    invalidReason: null
  };
}

// ─── Core Decision Function ───────────────────────────────────────────────────

/**
 * Classify a single inference result as one of:
 *   'pepper'       — confident pepper detection (beats runner-up by margin)
 *   'papaya'       — confident papaya detection (beats runner-up by margin)
 *   'background'   — background/not-a-seed class dominant or above gate
 *   'uncertain'    — probabilities valid but no class meets the confidence/margin bar
 *   'invalid'      — predictions are malformed or required fields are missing
 *
 * This function is PURE:
 *   • No DOM access
 *   • No Arduino / serial commands
 *   • No timers, audio, or animations
 *   • No global state read or written
 *
 * @param {Array}   predictions             – Raw tmImage predict() output
 * @param {object}  [opts]                  – Configuration overrides
 * @param {number}  [opts.threshold]        – Minimum winning probability (default 0.90)
 * @param {number}  [opts.margin]           – Minimum lead over runner-up (default 0.20)
 * @param {number}  [opts.bgThreshold]      – Max allowed background prob before rejection (default 0.35)
 * @returns {{ decision: string, reason: string, pepperProb: number, papayaProb: number, backgroundProb: number, hasBgClass: boolean }}
 */
function classifyPrediction(predictions, opts = {}) {
  const threshold   = (typeof opts.threshold   === 'number') ? opts.threshold   : DEFAULT_THRESHOLD;
  const margin      = (typeof opts.margin      === 'number') ? opts.margin      : DEFAULT_MARGIN;
  const bgThreshold = (typeof opts.bgThreshold === 'number') ? opts.bgThreshold : DEFAULT_BG_THRESHOLD;

  const parsed = parsePredictions(predictions);

  if (!parsed.valid) {
    return {
      decision: 'invalid',
      reason: parsed.invalidReason,
      pepperProb: 0, papayaProb: 0, backgroundProb: 0,
      hasBgClass: false
    };
  }

  const { pepperProb, papayaProb, backgroundProb, hasBgClass } = parsed;

  // Background-dominant or above background threshold
  const isBgDominant = hasBgClass && (backgroundProb >= pepperProb && backgroundProb >= papayaProb);
  if (hasBgClass && (backgroundProb > bgThreshold || isBgDominant)) {
    const reason = isBgDominant
      ? `Background class is dominant: ${(backgroundProb * 100).toFixed(1)}% (Pepper: ${(pepperProb * 100).toFixed(1)}%, Papaya: ${(papayaProb * 100).toFixed(1)}%).`
      : `Background class probability ${(backgroundProb * 100).toFixed(1)}% > ${(bgThreshold * 100).toFixed(0)}% gate.`;
    return {
      decision: 'background',
      reason,
      pepperProb, papayaProb, backgroundProb,
      hasBgClass
    };
  }

  // Calculate runner-up probabilities for winning class margin
  const pepperRunnerUp = hasBgClass ? Math.max(papayaProb, backgroundProb) : papayaProb;
  const papayaRunnerUp = hasBgClass ? Math.max(pepperProb, backgroundProb) : pepperProb;

  // Pepper wins
  if (pepperProb >= threshold && (pepperProb - pepperRunnerUp) >= margin) {
    return {
      decision: 'pepper',
      reason: `Pepper ${(pepperProb * 100).toFixed(1)}% ≥ ${(threshold * 100).toFixed(0)}%, margin ${((pepperProb - pepperRunnerUp) * 100).toFixed(1)}% ≥ ${(margin * 100).toFixed(0)}%.`,
      pepperProb, papayaProb, backgroundProb,
      hasBgClass
    };
  }

  // Papaya wins
  if (papayaProb >= threshold && (papayaProb - papayaRunnerUp) >= margin) {
    return {
      decision: 'papaya',
      reason: `Papaya ${(papayaProb * 100).toFixed(1)}% ≥ ${(threshold * 100).toFixed(0)}%, margin ${((papayaProb - papayaRunnerUp) * 100).toFixed(1)}% ≥ ${(margin * 100).toFixed(0)}%.`,
      pepperProb, papayaProb, backgroundProb,
      hasBgClass
    };
  }

  return {
    decision: 'uncertain',
    reason: `No class meets threshold=${(threshold * 100).toFixed(0)}% + margin=${(margin * 100).toFixed(0)}%. (Pepper=${(pepperProb * 100).toFixed(1)}%, Papaya=${(papayaProb * 100).toFixed(1)}%${hasBgClass ? `, Bg=${(backgroundProb * 100).toFixed(1)}%` : ''}).`,
    pepperProb, papayaProb, backgroundProb,
    hasBgClass
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
   * @param {boolean} presenceClean  – true = optical gate says chamber is genuinely empty
   * @param {boolean} gateActive     – true = optical gate is enabled
   * @returns {{ action: string|null, confirmCount: number, candidateClass: string|null, latched: boolean, emptyFrameCount: number }}
   */
  update(decision, presenceClean, gateActive) {
    const isSeedDecision = (decision === 'pepper' || decision === 'papaya');
    const isEmptyFrame   = (presenceClean === true);  // strictly true = genuinely empty confirmed

    // ── Rearm logic ──
    if (this.latched) {
      if (isEmptyFrame) {
        this.emptyFrameCount++;
        if (this.emptyFrameCount >= this.rearmEmptyFrames) {
          // Rearm: ready to detect next seed insertion
          this.latched         = false;
          this.emptyFrameCount = 0;
          this.candidateClass  = null;
          this.confirmCount    = 0;
        }
      } else {
        // Non-empty: reset emptyFrameCount so partial empty sequences don't rearm
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
      // New candidate class; start fresh
      this.candidateClass = decision;
      this.confirmCount   = 1;
    }

    if (this.confirmCount >= this.confirmFrames) {
      // Enough consecutive frames — fire action and set latch
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
// Supports Node.js (require), browser global script loading, and ES module environments.

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
    DEFAULT_BG_THRESHOLD,
    DEFAULT_CONFIRM_FRAMES,
    DEFAULT_REARM_EMPTY_FRAMES
  };
}

// In browser environments, also attach explicitly to window/globalThis for robustness
if (typeof globalThis !== 'undefined') {
  globalThis.validateModel        = validateModel;
  globalThis.parsePredictions     = parsePredictions;
  globalThis.classifyPrediction   = classifyPrediction;
  globalThis.SortLatch            = SortLatch;
  globalThis.DEFAULT_THRESHOLD    = DEFAULT_THRESHOLD;
  globalThis.DEFAULT_MARGIN       = DEFAULT_MARGIN;
  globalThis.DEFAULT_BG_THRESHOLD = DEFAULT_BG_THRESHOLD;
}
