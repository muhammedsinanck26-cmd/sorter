# Phase B: Genuine Three-Class Seed Dataset Specification

## 1. Overview & Objective

Phase B addresses the fundamental limitation of the Phase A two-class model: **a 2-class softmax model cannot inherently recognize an empty chute, a hand, or an unknown object.**

This dataset structure supports training and evaluating a genuine **three-class image classification model** using Google Teachable Machine:
1. `pepper_seed` (Class 1 — Target live sorting class A)
2. `papaya_seed` (Class 2 — Target live sorting class B)
3. `other_background` (Class 3 — Negative rejection class)

---

## 2. Directory Layout & Data Splits

```
data/phase_b/
├── train/                     <-- Model fitting ONLY
│   ├── pepper_seed/           (Target: 100–300 varied images)
│   ├── papaya_seed/           (Target: 100–300 varied images)
│   └── other_background/      (Target: 150–400 varied negative images)
├── validation/                <-- Decision threshold tuning & policy selection
│   ├── pepper_seed/           (Target: 30–60 independent images)
│   ├── papaya_seed/           (Target: 30–60 independent images)
│   └── other_background/      (Target: 50–100 independent negative images)
└── test/                      <-- Frozen final evaluation (evaluate.html)
    ├── pepper_seed/           (Target: 30–60 held-out images)
    ├── papaya_seed/           (Target: 30–60 held-out images)
    └── other_background/      (Target: 50–100 held-out negative images)
```

---

## 3. Class Definitions & Negative Class Requirements

### Class 1: `pepper_seed`
* **Subject**: Genuine black pepper seeds (*Piper nigrum*).
* **Variations needed**:
  * Individual single seeds centered and off-center in the reticle.
  * Small clusters (2–4 seeds) as occasionally transit together.
  * Natural variations in size, wrinkling, and darkness (deep black to dark grayish brown).
  * Varied orientation and lighting (direct light, side shadows, ambient diffuse).

### Class 2: `papaya_seed`
* **Subject**: Genuine papaya seeds (*Carica papaya*).
* **Variations needed**:
  * Fresh/glistening vs. dried/matte surface textures.
  * Characteristic gelatinous membrane residue / ridges.
  * Color spectrum: dark brown, brownish-black, amber-tinged.
  * Varied angles, orientations, and cluster configurations.

### Class 3: `other_background` (Crucial Negative Class)
> [!IMPORTANT]
> The negative class must **NOT** consist merely of empty chute images. It must contain balanced, representative imagery across all of the following 7 negative sub-categories:

1. **Empty Chute & Ambient Variations**:
   * Clean empty chute at different times of day (morning light, warm evening light, overhead fluorescents).
   * Empty chute with slight dust, micro-scratches, or small vibration blur.
2. **Human Hands & Skin**:
   * Fingers placing or dropping a seed.
   * Back of hand, fingertips, varied skin tones, different angles in view.
3. **White Paper, Rolled Paper & Packaging**:
   * White notebook paper, receipt paper, cardboard scrap, glossy packaging.
   * Flat and rolled/folded paper slips (simulating chutes or debris).
4. **Colored Surfaces & Stray Materials**:
   * Green cutting mats / mousepads, blue plastic tape, dark cloth.
   * Stray fibers, lint, rubber bands.
5. **Other Seeds & Spices (Hard Impostors)**:
   * Coriander seeds, cumin seeds, mustard seeds, fenugreek, peppercorn lookalikes.
   * Small gravel or pebbles.
6. **Tools, Containers & Hardware**:
   * Tweezers, measuring spoons, petri dish rims, glass vials, pen tips.
7. **Lighting Edge Cases**:
   * Strong directional shadows, desk lamp glare, momentary camera auto-exposure flash.

---

## 4. Image Capture Protocol

1. **Camera Alignment**:
   * Capture all primary training data through the **exact deployment webcam/camera** at 224×224 resolution (or square 1:1 aspect ratio matching the chute reticle).
   * Keep the camera distance fixed at the operational focal distance (~5–10 cm from the sorting plate/chute).
2. **Lighting Conditions**:
   * Collect images under natural room light, artificial desk LED, and dimmer ambient conditions to build illumination invariance.
3. **Image Format & Specifications**:
   * Standard `.jpg` or `.png` images.
   * Minimum resolution: 224×224 pixels (Teachable Machine standard input).
   * Color: Standard 24-bit RGB (no grayscale conversions).

---

## 5. Strict Data Hygiene & Leakage Prevention Rules

* **Rule 1: Split Independence**:
  * Never split a continuous video recording across train and test! If a video is captured at 30 FPS, consecutive frames are near-clones ($r > 0.98$ pixel correlation).
  * Use separate seed batches or separate capture sessions for `train`, `validation`, and `test`.
* **Rule 2: Frozen Test Set**:
  * The `test/` split is strictly for final benchmarking in `evaluate.html`.
  * Never tune decision thresholds, margins, or retrain models based on `test/` performance.
* **Rule 3: Duplicate Hash Checking**:
  * Run `node audit_dataset.js` before training to verify zero exact duplicate files across splits.
