# Phase B: Genuine Three-Class Seed Classification Guide

## 1. Executive Summary & Problem Definition

In **Phase A**, safety guardrails, multi-frame confirmation, and an optical presence gate were implemented to prevent spurious actuation. However, Phase A still operated on a fundamental model limitation:
> **A 2-class softmax model ($\text{Softmax}(z) \in \mathbb{R}^2$) cannot express "none of the above".**
> Its probabilities always sum to 1.0. An empty chute, a hand, rolled white paper, or arbitrary debris is inevitably mapped to either Pepper or Papaya. The optical presence gate was the sole line of defense.

**Phase B** advances the architecture to a genuine **Three-Class Machine Learning Pipeline**:
1. `pepper_seed` — Primary Sort Class 1
2. `papaya_seed` — Primary Sort Class 2
3. `other_background` — Hard-Negative Rejection Class

This document details the exact protocols for data collection, leakage prevention, Teachable Machine training, candidate model validation, threshold selection, and safe promotion.

---

## 2. Dataset Capture Protocol

### 2.1 Environmental Conditions
* **Camera Setup**: Capture training, validation, and test imagery using the **exact physical webcam** mounted above the sorting chute at the operational focal distance (~5–10 cm).
* **Resolution**: 224×224 pixels (1:1 square aspect ratio matching Teachable Machine input).
* **Lighting Variations**: Capture data across 3 distinct lighting regimes:
  1. Ambient indoor room illumination.
  2. Directed LED task light (simulating sorter illuminator).
  3. Dim / shadowed lighting (simulating late afternoon / changing room light).

### 2.2 Target Image Counts per Class
| Class Name | Train Split | Validation Split | Test Split | Minimum Target Total |
|---|---|---|---|---|
| `pepper_seed` | 150–300 | 40–60 | 40–60 | **230–420** |
| `papaya_seed` | 150–300 | 40–60 | 40–60 | **230–420** |
| `other_background` | 200–400 | 60–100 | 60–100 | **320–600** |

### 2.3 Critical Requirements for `other_background`
Do **NOT** fill the negative class exclusively with empty chute images. An effective negative class must include representative examples across 7 categories:
1. **Empty Chute**: Clean background plate under varying light.
2. **Human Hands & Skin**: Fingers placing seeds, fingertips, varied skin tones.
3. **White Paper & Packaging**: Flat paper, rolled tubes, cardboard scrap, receipt paper.
4. **Colored Surfaces**: Green cutting mats, blue tape, dark fabric.
5. **Other Seeds & Impostors**: Coriander, cumin, mustard seeds, gravel.
6. **Hardware & Tools**: Tweezers, measuring spoons, petri dishes, pens.
7. **Optical Edge Cases**: Glare reflections, deep shadows across the reticle.

---

## 3. Data Separation & Leakage Prevention

* **Rule 1: Never Split Continuous Video Frames**:
  * Adjacent frames from a 30 FPS video have $r > 0.98$ pixel correlation. Placing frame $N$ in `train` and frame $N+1$ in `test` produces synthetic 99%+ accuracy that collapses in production.
  * Use **independent capture sessions** or distinct physical seed specimens for train, validation, and test splits.
* **Rule 2: Automated Leakage Auditing**:
  * Always execute the dataset auditor before training:
    ```bash
    node audit_dataset.js
    ```
  * `audit_dataset.js` computes SHA-256 hashes of all files and will flag any cross-split duplicate as an error.

---

## 4. Teachable Machine Training Workflow

1. Navigate to [Google Teachable Machine Image Project](https://teachablemachine.withgoogle.com/train/image).
2. Select **Standard Image Model** (224×224 color input, MobileNet base).
3. Create exactly **three classes** with these canonical names:
   * Class 1: `pepper_seed`
   * Class 2: `papaya_seed`
   * Class 3: `other_background`
4. Upload images from `data/phase_b/train/` to their respective classes:
   * Upload `data/phase_b/train/pepper_seed/` into `pepper_seed`.
   * Upload `data/phase_b/train/papaya_seed/` into `papaya_seed`.
   * Upload `data/phase_b/train/other_background/` into `other_background`.
5. **Training Parameters**:
   * Epochs: `50`
   * Batch Size: `16`
   * Learning Rate: `0.001`
6. Click **Train Model** and allow training to complete.

---

## 5. Export, Staging & Pre-Promotion Verification

### 5.1 Export Procedure
1. In Teachable Machine, click **Export Model**.
2. Select the **TensorFlow.js** tab.
3. Select **Upload (shareable link)** or **Download my model**. Choose **Download**.
4. Download the generated `.zip` file.

### 5.2 Staging the Candidate Model
1. Extract the downloaded zip file into `candidate_model/`:
   * `candidate_model/model.json`
   * `candidate_model/weights.bin`
   * `candidate_model/metadata.json`
2. **Never overwrite the root production model directly!**
3. Run the automated candidate validator:
   ```bash
   node validate_candidate.js
   ```
   Verify that:
   * Output units = 3
   * Activation = `softmax`
   * Labels match `[pepper_seed, papaya_seed, other_background]`
   * Weight byte size matches the manifest expectation.

---

## 6. Threshold Selection & Evaluation Protocol

1. Start the local server:
   ```bash
   python -m http.server 8000
   ```
2. Open `http://localhost:8000/evaluate.html`.
3. In Step 1, select **Candidate Model (./candidate_model/)** and click **Initialize & Validate Model**.
4. In Step 2, click the drop zone and select `data/phase_b/validation/`.
5. Click **▶ Run Evaluation**.
6. **Tune Policy Sliders**:
   * Adjust **Winning Threshold** (default: 90%) and **Winning Margin** (default: 20%).
   * Monitor the **Background False Acceptance Rate (FAR)**: FAR must be **0.0%** (no negative images should actuate).
7. **Freeze Policy & Final Test Run**:
   * Once thresholds are selected on the validation set, **freeze them**.
   * Select `data/phase_b/test/` and run evaluation to generate the official un-tuned test metrics.

---

## 7. Safe Promotion & Rollback Procedure

### 7.1 Promotion Checklist
Promote the candidate model to production ONLY when:
- [ ] `node validate_candidate.js` passes with 0 errors.
- [ ] `evaluate.html` test set accuracy $\ge 90\%$ with FAR $= 0\%$.
- [ ] `node test_gate.js` passes 100% of safety tests.
- [ ] Working tree has been backed up.

### 7.2 Atomic Promotion Command
Run in PowerShell:
```powershell
# 1. Create timestamped backup of current active model
$ts = Get-Date -Format "yyyyMMdd_HHmmss"
New-Item -ItemType Directory -Force "backups/model_$ts"
Copy-Item model.json, metadata.json, weights.bin "backups/model_$ts/"

# 2. Promote candidate model
Copy-Item candidate_model/model.json, candidate_model/metadata.json, candidate_model/weights.bin ./

# 3. Verify active model
node validate_candidate.js --dir .
node test_gate.js
```

### 7.3 Rollback Command
If any issue occurs during live sorting:
```powershell
# Restore from latest backup
$latestBackup = Get-ChildItem backups -Directory | Sort-Object CreationTime -Descending | Select-Object -First 1
Copy-Item "$($latestBackup.FullName)/*" ./
node test_gate.js
```

---

## 8. Known Limitations of Three-Class Classifiers

1. **Open-Set Generalization**:
   Even a genuine 3-class model remains a closed-world classifier. An object radically dissimilar to anything in `pepper_seed`, `papaya_seed`, or `other_background` can still produce unpredictable softmax responses.
2. **Layered Defense**:
   The hardware-grade **optical presence gate** implemented in Phase A must remain active. Machine learning probability gating and optical photometric gating work as complementary layers, not mutually exclusive replacements.
