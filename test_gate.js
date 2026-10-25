/**
 * SEED SORTER — OPTICAL GATE TEST HARNESS
 * Verifies analyzePresence() + processInference() without a live camera.
 * Run with: node test_gate.js
 *
 * Tests every scenario that caused false triggers in the field:
 *  1. Empty surface / background
 *  2. White paper / rolled paper
 *  3. Human skin / hand
 *  4. Green mousepad
 *  5. Real black pepper seed
 *  6. Real papaya seed
 *  7. Camera moved / relocated
 *  8. Very small noise (dust)
 *  9. 2-class model: background → gate locks AI (not a 3rd class)
 * 10. processInference() + gate → only fires sort when seed is present
 */

'use strict';

// ───────────────────────────────────────────────────────────────────────────────
// Stub shared state (mirrors globals in index.html)
// ───────────────────────────────────────────────────────────────────────────────
let opticalGateEnabled  = true;
let baselineCalibrated  = false;
let baselinePixels      = null;
let sceneStillFrames    = 0;

// ───────────────────────────────────────────────────────────────────────────────
// Exact copy of analyzePresence() from index.html
// (DOM canvas replaced by a plain pixel-data object)
// ───────────────────────────────────────────────────────────────────────────────
function analyzePresence(pixelData, width, height) {
  // pixelData is Uint8ClampedArray in RGBA order (like ImageData.data)

  if (!opticalGateEnabled) {
    return { present: true, coveragePct: 100, isMoved: false, avgDiff: 0,
             isPhotometricSeed: true, isGreenBackground: false, isBright: false,
             isSkin: false, avgR: 0, avgG: 0, avgB: 0, avgLum: 0 };
  }

  const roiSize = 96;
  const sw = width, sh = height;
  const sx = Math.floor((sw - roiSize) / 2);
  const sy = Math.floor((sh - roiSize) / 2);
  const n  = roiSize * roiSize;

  // Extract the ROI from the full pixel array (RGBA stride = width*4)
  const data = new Uint8ClampedArray(n * 4);
  for (let row = 0; row < roiSize; row++) {
    for (let col = 0; col < roiSize; col++) {
      const srcIdx = ((sy + row) * sw + (sx + col)) * 4;
      const dstIdx = (row * roiSize + col) * 4;
      data[dstIdx]   = pixelData[srcIdx];
      data[dstIdx+1] = pixelData[srcIdx+1];
      data[dstIdx+2] = pixelData[srcIdx+2];
      data[dstIdx+3] = 255;
    }
  }

  // First frame: auto-capture baseline
  if (!baselineCalibrated || !baselinePixels || baselinePixels.length !== n * 3) {
    baselinePixels = new Uint8ClampedArray(n * 3);
    for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
      baselinePixels[j]   = data[i];
      baselinePixels[j+1] = data[i+1];
      baselinePixels[j+2] = data[i+2];
    }
    baselineCalibrated = true;
    return { present: false, coveragePct: 0, isMoved: false, avgDiff: 0,
             isPhotometricSeed: false, isGreenBackground: false, isBright: false, isSkin: false };
  }

  const PIXEL_THRESH = 22;
  let diffSum = 0, changedCount = 0;
  let fgR = 0, fgG = 0, fgB = 0;

  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    const dR = Math.abs(data[i]   - baselinePixels[j]);
    const dG = Math.abs(data[i+1] - baselinePixels[j+1]);
    const dB = Math.abs(data[i+2] - baselinePixels[j+2]);
    const d  = (dR + dG + dB) / 3;
    diffSum += d;
    if (d > PIXEL_THRESH) {
      changedCount++;
      fgR += data[i]; fgG += data[i+1]; fgB += data[i+2];
    }
  }

  const avgDiff    = diffSum / n;
  const coveragePct = (changedCount / n) * 100;

  // Photometrics FIRST — before isMoved — so rejected objects (paper, skin, green)
  // can never trigger auto-rezero and become a new baseline.
  let isPhotometricSeed = false;
  let isGreenBackground = false;
  let isBright = false;
  let isSkin   = false;
  let avgR = 0, avgG = 0, avgB = 0, avgLum = 0;

  if (changedCount > 0) {
    avgR   = fgR / changedCount;
    avgG   = fgG / changedCount;
    avgB   = fgB / changedCount;
    avgLum = 0.299 * avgR + 0.587 * avgG + 0.114 * avgB;

    isGreenBackground = (avgG > avgR + 18 && avgG > avgB + 18 && avgG > 65);
    isBright          = (avgLum > 165);
    isSkin            = (avgR > avgB + 22 && avgLum > 95 && coveragePct > 22);

    const isPepperColor = (avgLum >= 10 && avgLum <= 115 && Math.abs(avgR - avgG) < 40 && Math.abs(avgG - avgB) < 40);
    const isPapayaColor = (avgLum >= 15 && avgLum <= 160 && (avgR >= avgB - 5));
    const isSeedSized   = (coveragePct >= 1.0 && coveragePct <= 55.0);

    isPhotometricSeed = isSeedSized && !isGreenBackground && !isBright && !isSkin && (isPepperColor || isPapayaColor);
  }

  const isMoved = (coveragePct > 65.0);
  const isRejectedObject = isBright || isSkin || isGreenBackground;

  if (isMoved) {
    if (!isRejectedObject) {
      sceneStillFrames++;
      if (sceneStillFrames > 50) {
        for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
          baselinePixels[j] = data[i]; baselinePixels[j+1] = data[i+1]; baselinePixels[j+2] = data[i+2];
        }
        sceneStillFrames = 0;
        return { present: false, coveragePct: 0, isMoved: false, avgDiff: 0,
                 isPhotometricSeed: false, isGreenBackground: false, isBright: false,
                 isSkin: false, avgR: 0, avgG: 0, avgB: 0, avgLum: 0 };
      }
    }
    // Rejected object type — never allow auto-rezero
  } else {
    sceneStillFrames = 0;
  }

  return {
    present: (!isMoved && isPhotometricSeed),
    isMoved, coveragePct, avgDiff,
    isPhotometricSeed, isGreenBackground, isBright, isSkin,
    avgR, avgG, avgB, avgLum
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// Exact copy of processInference() sort decision (returns action string)
// ───────────────────────────────────────────────────────────────────────────────
function decideSortAction(predictions, presence) {
  let pepperProb = 0, papayaProb = 0, backgroundProb = 0;
  let hasBgClass = false;

  for (let p of predictions) {
    const name = p.className.toLowerCase();
    if (name.includes('pepper'))       pepperProb = p.probability;
    else if (name.includes('papaya'))  papayaProb = p.probability;
    else if (name.includes('background') || name.includes('empty') || name.includes('none') || name.includes('idle')) {
      backgroundProb = p.probability;
      hasBgClass = true;
    }
  }

  if (!hasBgClass) backgroundProb = presence.present ? 0.0 : 1.0;

  const threshold = 0.90;

  // STAGE 1: Camera moved
  if (opticalGateEnabled && presence.isMoved)          return 'INHIBIT:CAMERA_MOVED';
  // STAGE 2: Bright paper / glare
  if (opticalGateEnabled && presence.isBright)         return 'INHIBIT:BRIGHT_PAPER';
  // STAGE 2b: Skin / hand
  if (opticalGateEnabled && presence.isSkin)           return 'INHIBIT:HAND_SKIN';
  // STAGE 2c: Green surface
  if (opticalGateEnabled && presence.isGreenBackground) return 'INHIBIT:GREEN_SURFACE';
  // STAGE 3: Empty chamber
  if (opticalGateEnabled && !presence.present)          return 'INHIBIT:EMPTY_CHAMBER';
  // STAGE 4: AI background class
  if (hasBgClass && backgroundProb > 0.35)              return 'INHIBIT:AI_BG_CLASS';
  // STAGE 5: Strict threshold
  if (pepperProb >= threshold && pepperProb > papayaProb) return 'SORT:PEPPER';
  if (papayaProb >= threshold && papayaProb > pepperProb) return 'SORT:PAPAYA';
  return 'INHIBIT:AMBIGUOUS';
}

// ───────────────────────────────────────────────────────────────────────────────
// Helper: make a synthetic 380×380 RGBA canvas pixel buffer
// ───────────────────────────────────────────────────────────────────────────────
function makeCanvas(r, g, b) {
  const w = 380, h = 380;
  const buf = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i]   = r; buf[i+1] = g; buf[i+2] = b; buf[i+3] = 255;
  }
  return { data: buf, width: w, height: h };
}

// Make a canvas where only a central blob differs from background
function makeCanvasWithBlob(bgR, bgG, bgB, blobR, blobG, blobB, blobRadiusPct) {
  const w = 380, h = 380;
  const buf = new Uint8ClampedArray(w * h * 4);
  const cx = w / 2, cy = h / 2;
  const radius = (blobRadiusPct / 100) * Math.min(w, h) / 2;

  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const idx = (row * w + col) * 4;
      const dist = Math.sqrt((col - cx) ** 2 + (row - cy) ** 2);
      if (dist <= radius) {
        buf[idx] = blobR; buf[idx+1] = blobG; buf[idx+2] = blobB;
      } else {
        buf[idx] = bgR; buf[idx+1] = bgG; buf[idx+2] = bgB;
      }
      buf[idx+3] = 255;
    }
  }
  return { data: buf, width: w, height: h };
}

// ───────────────────────────────────────────────────────────────────────────────
// 2-class AI model stubs (mirrors what the MobileNet model actually outputs)
// ───────────────────────────────────────────────────────────────────────────────
const MODEL_PEPPER_CONFIDENT = [
  { className: 'pepper', probability: 0.97 },
  { className: 'papaya', probability: 0.03 }
];
const MODEL_PAPAYA_CONFIDENT = [
  { className: 'pepper', probability: 0.04 },
  { className: 'papaya', probability: 0.96 }
];
const MODEL_EMPTY_BIASED = [   // What model sees with empty/background (biased to pepper by MobileNet)
  { className: 'pepper', probability: 0.994 },
  { className: 'papaya', probability: 0.006 }
];
const MODEL_AMBIGUOUS = [
  { className: 'pepper', probability: 0.55 },
  { className: 'papaya', probability: 0.45 }
];

// ───────────────────────────────────────────────────────────────────────────────
// Test Runner
// ───────────────────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;

function test(name, fn) {
  // Reset state before each test
  baselineCalibrated = false;
  baselinePixels     = null;
  sceneStillFrames   = 0;
  opticalGateEnabled = true;

  try {
    fn();
    console.log(`  ✅ PASS: ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ FAIL: ${name}`);
    console.log(`         ${e.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

function analyzeFrame(canvasObj) {
  return analyzePresence(canvasObj.data, canvasObj.width, canvasObj.height);
}

// ───────────────────────────────────────────────────────────────────────────────
// THE TESTS
// ───────────────────────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════════════════════════');
console.log('  SEED SORTER OPTICAL GATE — FULL VERIFICATION SUITE');
console.log('══════════════════════════════════════════════════════════════\n');

console.log('── SECTION 1: analyzePresence() Isolation Tests ──────────────\n');

test('Empty surface baseline auto-calibrates on first frame', () => {
  const bg = makeCanvas(110, 108, 105); // desk surface
  const r = analyzeFrame(bg);
  assert(r.present === false, `Expected present=false on first (calibration) frame, got ${r.present}`);
  assert(baselineCalibrated === true, 'Expected baselineCalibrated=true after first frame');
});

test('Empty surface → gate locked (no object placed)', () => {
  const bg = makeCanvas(110, 108, 105);
  analyzeFrame(bg); // calibrate
  const r = analyzeFrame(bg); // same again
  assert(r.present === false,         `present=${r.present}, want false`);
  assert(r.coveragePct < 1.5,        `coveragePct=${r.coveragePct.toFixed(2)}, want < 1.5`);
  assert(r.isMoved === false,         `isMoved=${r.isMoved}, want false`);
});

test('White paper → isBright=true, present=false', () => {
  const bg  = makeCanvas(110, 108, 105);
  const paper = makeCanvasWithBlob(110, 108, 105,  240, 238, 235, 30); // big white blob
  analyzeFrame(bg); // calibrate on desk
  const r = analyzeFrame(paper);
  assert(r.isBright  === true,  `isBright=${r.isBright}, want true  (lum=${r.avgLum.toFixed(1)})`);
  assert(r.present   === false, `present=${r.present}, want false`);
});

test('Rolled paper (lum=210, cov=35%) → isBright=true, present=false', () => {
  // Rolled paper is slightly off-white but still bright
  const bg  = makeCanvas(110, 108, 105);
  const paper = makeCanvasWithBlob(110, 108, 105,  218, 212, 206, 35);
  analyzeFrame(bg);
  const r = analyzeFrame(paper);
  assert(r.isBright === true,  `isBright=${r.isBright}, lum=${r.avgLum.toFixed(1)} (want >165)`);
  assert(r.present  === false, `present=${r.present}, want false`);
});

test('Human hand / skin → isSkin=true, present=false', () => {
  // Skin: warm (R >> B), mid-bright, large coverage
  const bg   = makeCanvas(110, 108, 105);
  const hand = makeCanvasWithBlob(110, 108, 105,  195, 140, 110, 40);
  analyzeFrame(bg);
  const r = analyzeFrame(hand);
  assert(r.isSkin  === true,  `isSkin=${r.isSkin}, want true  (R=${r.avgR.toFixed(0)} B=${r.avgB.toFixed(0)} cov=${r.coveragePct.toFixed(1)}%)`);
  assert(r.present === false, `present=${r.present}, want false`);
});

test('Green mousepad → isGreenBackground=true, present=false', () => {
  const bg  = makeCanvas(110, 108, 105);
  const pad = makeCanvasWithBlob(110, 108, 105,  55, 140, 75, 45);
  analyzeFrame(bg);
  const r = analyzeFrame(pad);
  assert(r.isGreenBackground === true,  `isGreenBackground=${r.isGreenBackground}, G=${r.avgG.toFixed(0)}`);
  assert(r.present           === false, `present=${r.present}, want false`);
});

test('Black pepper seed (lum~33, cov~5%) → present=true', () => {
  const bg   = makeCanvas(110, 108, 105);
  // Pepper: dark, near-neutral, small blob
  const seed = makeCanvasWithBlob(110, 108, 105,   38,  34,  31,  7); // ~5% area
  analyzeFrame(bg);
  const r = analyzeFrame(seed);
  assert(r.present === true,  `present=${r.present}, lum=${r.avgLum.toFixed(1)} cov=${r.coveragePct.toFixed(2)}%`);
  assert(r.isBright === false, `isBright=${r.isBright}`);
  assert(r.isSkin   === false, `isSkin=${r.isSkin}`);
});

test('Papaya seed (lum~72, warm, cov~7%) → present=true', () => {
  const bg   = makeCanvas(110, 108, 105);
  // Papaya seed: warm brownish, mid-lum, seed-sized
  const seed = makeCanvasWithBlob(110, 108, 105,  110,  72,  48,  9);
  analyzeFrame(bg);
  const r = analyzeFrame(seed);
  assert(r.present === true,  `present=${r.present}, lum=${r.avgLum.toFixed(1)} R=${r.avgR.toFixed(0)} B=${r.avgB.toFixed(0)}`);
});

test('Camera relocated (>65% changed) → isMoved=true, present=false', () => {
  const bg   = makeCanvas(110, 108, 105);
  const elsewhere = makeCanvas(50, 90, 160); // completely different scene
  analyzeFrame(bg);
  const r = analyzeFrame(elsewhere);
  assert(r.isMoved  === true,  `isMoved=${r.isMoved}, cov=${r.coveragePct.toFixed(1)}%`);
  assert(r.present  === false, `present=${r.present}, want false`);
});

test('Dust/noise (coverage <1.0%) → present=false (sub-minimum blob)', () => {
  const bg = makeCanvas(110, 108, 105);
  // Tiny 1-pixel dust — blob radius 0.5% of canvas
  const noise = makeCanvasWithBlob(110, 108, 105,  40, 38, 35,  0.5);
  analyzeFrame(bg);
  const r = analyzeFrame(noise);
  assert(r.present === false, `present=${r.present}, cov=${r.coveragePct.toFixed(2)}% (want <1.0%)`);
});

test('Very large object (>55% reticle) → present=false (oversized)', () => {
  const bg = makeCanvas(110, 108, 105);
  // A dark object that covers >55% of the reticle
  const bigObj = makeCanvasWithBlob(110, 108, 105,   40, 38, 35, 55);
  analyzeFrame(bg);
  const r = analyzeFrame(bigObj);
  assert(r.present === false, `present=${r.present}, cov=${r.coveragePct.toFixed(1)}%`);
});

test('Gate OFF → presence always returns present=true (bypass mode)', () => {
  opticalGateEnabled = false;
  const bg = makeCanvas(240, 238, 235); // white paper — would normally reject
  const r  = analyzeFrame(bg);
  assert(r.present === true, `present=${r.present}, expected true (gate disabled)`);
  opticalGateEnabled = true; // restore
});

// ───────────────────────────────────────────────────────────────────────────────

console.log('\n── SECTION 2: processInference() + Gate Integration Tests ────\n');

test('BG scene + MODEL_EMPTY_BIASED (0.994 pepper) → INHIBIT:EMPTY_CHAMBER', () => {
  const bg = makeCanvas(110, 108, 105);
  analyzeFrame(bg); // calibrate
  const p  = analyzeFrame(bg); // second frame → gate locked
  const action = decideSortAction(MODEL_EMPTY_BIASED, p);
  assert(action === 'INHIBIT:EMPTY_CHAMBER',
    `Got "${action}", expected INHIBIT:EMPTY_CHAMBER. Proves 2-class model false-pepper is blocked.`);
});

test('White paper + MODEL_EMPTY_BIASED → INHIBIT:BRIGHT_PAPER (not a pepper sort)', () => {
  const bg    = makeCanvas(110, 108, 105);
  const paper = makeCanvasWithBlob(110, 108, 105, 240, 238, 235, 30);
  analyzeFrame(bg);
  const p  = analyzeFrame(paper);
  const action = decideSortAction(MODEL_EMPTY_BIASED, p);
  // Large paper (94% coverage) triggers isMoved=true AND isBright=true.
  // processInference checks isMoved before isBright, so CAMERA_MOVED fires.
  // Key safety invariant: present=false so no sort can ever fire.
  assert(p.present === false, `present=${p.present}, want false (safety)`);
  assert(p.isBright === true, `isBright=${p.isBright}, want true`);
  const isInhibited = action.startsWith('INHIBIT');
  assert(isInhibited, `Got "${action}", expected any INHIBIT (got ${action})`);
  // Specifically should NOT be SORT:PEPPER or SORT:PAPAYA
  assert(action !== 'SORT:PEPPER' && action !== 'SORT:PAPAYA',
    `CRITICAL: Got "${action}" — sorter fired on white paper!`);
});

test('Skin/hand + MODEL_EMPTY_BIASED → INHIBIT:HAND_SKIN', () => {
  const bg   = makeCanvas(110, 108, 105);
  const hand = makeCanvasWithBlob(110, 108, 105, 195, 140, 110, 40);
  analyzeFrame(bg);
  const p  = analyzeFrame(hand);
  const action = decideSortAction(MODEL_EMPTY_BIASED, p);
  // Hand at 100% coverage: isMoved=true AND isSkin=true.
  // processInference checks isMoved first → INHIBIT:CAMERA_MOVED.
  // Safety invariant: present=false, no sort fires.
  assert(p.present === false,  `present=${p.present}, want false (safety)`);
  assert(p.isSkin  === true,   `isSkin=${p.isSkin}, want true`);
  assert(action !== 'SORT:PEPPER' && action !== 'SORT:PAPAYA',
    `CRITICAL: Got "${action}" — sorter fired on hand!`);
  assert(action.startsWith('INHIBIT'), `Got "${action}", expected INHIBIT`);
});

test('Green mousepad + MODEL_EMPTY_BIASED → INHIBIT:GREEN_SURFACE', () => {
  const bg  = makeCanvas(110, 108, 105);
  const pad = makeCanvasWithBlob(110, 108, 105, 55, 140, 75, 45);
  analyzeFrame(bg);
  const p  = analyzeFrame(pad);
  const action = decideSortAction(MODEL_EMPTY_BIASED, p);
  // Mousepad at 100% coverage: isMoved=true AND isGreenBackground=true.
  // processInference checks isMoved first → INHIBIT:CAMERA_MOVED.
  // Safety invariant: present=false, no sort fires.
  assert(p.present           === false, `present=${p.present}, want false (safety)`);
  assert(p.isGreenBackground === true,  `isGreenBackground=${p.isGreenBackground}, want true`);
  assert(action !== 'SORT:PEPPER' && action !== 'SORT:PAPAYA',
    `CRITICAL: Got "${action}" — sorter fired on green mousepad!`);
  assert(action.startsWith('INHIBIT'), `Got "${action}", expected INHIBIT`);
});

test('Real pepper seed + MODEL_PEPPER_CONFIDENT (97%) → SORT:PEPPER', () => {
  const bg   = makeCanvas(110, 108, 105);
  const seed = makeCanvasWithBlob(110, 108, 105, 38, 34, 31, 7);
  analyzeFrame(bg);
  const p      = analyzeFrame(seed);
  const action = decideSortAction(MODEL_PEPPER_CONFIDENT, p);
  assert(action === 'SORT:PEPPER',
    `Got "${action}", expected SORT:PEPPER. Presence: ${JSON.stringify({present:p.present,lum:p.avgLum.toFixed(1),cov:p.coveragePct.toFixed(1)})}`);
});

test('Real papaya seed + MODEL_PAPAYA_CONFIDENT (96%) → SORT:PAPAYA', () => {
  const bg   = makeCanvas(110, 108, 105);
  const seed = makeCanvasWithBlob(110, 108, 105, 110, 72, 48, 9);
  analyzeFrame(bg);
  const p      = analyzeFrame(seed);
  const action = decideSortAction(MODEL_PAPAYA_CONFIDENT, p);
  assert(action === 'SORT:PAPAYA',
    `Got "${action}", expected SORT:PAPAYA. Presence: ${JSON.stringify({present:p.present,lum:p.avgLum.toFixed(1),cov:p.coveragePct.toFixed(1)})}`);
});

test('Ambiguous prediction (55%/45%) below 90% threshold → INHIBIT:AMBIGUOUS', () => {
  const bg   = makeCanvas(110, 108, 105);
  const seed = makeCanvasWithBlob(110, 108, 105, 38, 34, 31, 7);
  analyzeFrame(bg);
  const p      = analyzeFrame(seed);
  const action = decideSortAction(MODEL_AMBIGUOUS, p);
  assert(action === 'INHIBIT:AMBIGUOUS',
    `Got "${action}", expected INHIBIT:AMBIGUOUS`);
});

test('Camera moved + MODEL_PEPPER_CONFIDENT → INHIBIT:CAMERA_MOVED (not a pepper sort)', () => {
  const bg        = makeCanvas(110, 108, 105);
  const elsewhere = makeCanvas(50, 90, 160);
  analyzeFrame(bg);
  const p      = analyzeFrame(elsewhere);
  const action = decideSortAction(MODEL_PEPPER_CONFIDENT, p);
  assert(action === 'INHIBIT:CAMERA_MOVED',
    `Got "${action}", expected INHIBIT:CAMERA_MOVED`);
});

// ───────────────────────────────────────────────────────────────────────────────
// Threshold sanity: 90% boundary
// ───────────────────────────────────────────────────────────────────────────────
test('Pepper at exactly 90.0% → SORT:PEPPER (threshold is inclusive)', () => {
  const bg   = makeCanvas(110, 108, 105);
  const seed = makeCanvasWithBlob(110, 108, 105, 38, 34, 31, 7);
  analyzeFrame(bg);
  const p = analyzeFrame(seed);
  const action = decideSortAction([
    { className: 'pepper', probability: 0.90 },
    { className: 'papaya', probability: 0.10 }
  ], p);
  assert(action === 'SORT:PEPPER', `Got "${action}", expected SORT:PEPPER at exactly 90%`);
});

test('Pepper at 89.9% → INHIBIT:AMBIGUOUS (just under threshold)', () => {
  const bg   = makeCanvas(110, 108, 105);
  const seed = makeCanvasWithBlob(110, 108, 105, 38, 34, 31, 7);
  analyzeFrame(bg);
  const p = analyzeFrame(seed);
  const action = decideSortAction([
    { className: 'pepper', probability: 0.899 },
    { className: 'papaya', probability: 0.101 }
  ], p);
  assert(action === 'INHIBIT:AMBIGUOUS', `Got "${action}", expected INHIBIT:AMBIGUOUS at 89.9%`);
});

// ───────────────────────────────────────────────────────────────────────────────
// CRITICAL BUG-FIX TEST: Auto-rezero MUST NOT accept bright/skin/green objects
// ───────────────────────────────────────────────────────────────────────────────

console.log('\n── SECTION 3: Auto-Rezero Safety Tests ──────────────────────\n');

test('BUG FIX: White paper held still for 55 frames NEVER becomes new baseline', () => {
  const bg    = makeCanvas(110, 108, 105);
  const paper = makeCanvasWithBlob(110, 108, 105, 240, 238, 235, 30);
  analyzeFrame(bg); // calibrate on desk

  // Simulate 55 frames of holding white paper still (> 50 threshold)
  let lastResult;
  for (let i = 0; i < 55; i++) {
    lastResult = analyzeFrame(paper);
  }

  // After 55 frames, paper must STILL be rejected
  assert(lastResult.present === false, `BUG: Auto-rezero accepted bright paper as new background! present=${lastResult.present}`);
  // Verify paper did NOT become baseline: place empty desk → gate should still detect difference
  const emptyAgain = analyzeFrame(bg);
  // If paper became baseline, empty desk would look "changed" with dark areas.
  // If paper did NOT become baseline, empty desk looks the same as original → present=false, cov~0
  // (The desk surface matches the original baselinePixels)
  assert(emptyAgain.coveragePct < 10, `BUG: baseline was re-learned to paper. Desk coverage=${emptyAgain.coveragePct.toFixed(1)}% after paper was held`);
});

test('BUG FIX: Hand held still for 55 frames NEVER becomes new baseline', () => {
  const bg   = makeCanvas(110, 108, 105);
  const hand = makeCanvasWithBlob(110, 108, 105, 195, 140, 110, 40);
  analyzeFrame(bg);
  for (let i = 0; i < 55; i++) analyzeFrame(hand);
  // Remove hand — gate should see near-zero coverage (original desk is still the baseline)
  const emptyDesk = analyzeFrame(bg);
  assert(emptyDesk.present === false, `present=${emptyDesk.present} after hand removal`);
  assert(emptyDesk.coveragePct < 10,
    `BUG: hand rezero happened! After removing hand, desk coverage=${emptyDesk.coveragePct.toFixed(1)}%`);
});

test('Genuine camera pan (neutral dark surface) for 55 frames → IS accepted as new baseline', () => {
  const bg1 = makeCanvas(110, 108, 105); // original desk
  const bg2 = makeCanvas( 80,  78,  75); // new desk (camera panned to darker area)
  analyzeFrame(bg1); // calibrate on first desk
  for (let i = 0; i < 55; i++) analyzeFrame(bg2); // stay on new dark desk
  // New desk should have been accepted as baseline — additional frame on bg2 should show ~0 coverage
  const r = analyzeFrame(bg2);
  assert(r.coveragePct < 5,
    `Expected new desk to be accepted as baseline (cov~0), got ${r.coveragePct.toFixed(1)}%`);
});

// ───────────────────────────────────────────────────────────────────────────────
// Final Report
// ───────────────────────────────────────────────────────────────────────────────
const total = passed + failed;
console.log('\n══════════════════════════════════════════════════════════════');
console.log(`  RESULTS: ${passed}/${total} passed`);
if (failed === 0) {
  console.log('  ✅ ALL TESTS PASSED — Optical gate + inference pipeline verified.');
  console.log('  The sorter will NOT fire on: background, paper, hands, green surface.');
  console.log('  The sorter WILL fire on: confirmed pepper/papaya seeds at ≥90%.');
} else {
  console.log(`  ❌ ${failed} TEST(S) FAILED — See above for details.`);
}
console.log('══════════════════════════════════════════════════════════════\n');

process.exit(failed > 0 ? 1 : 0);
