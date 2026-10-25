# Candidate Model Staging Area

## Purpose
This directory is reserved for staging a newly trained Teachable Machine 3-class export (`model.json`, `weights.bin`, `metadata.json`) **before** evaluation and promotion into production.

> [!CAUTION]
> **DO NOT** copy candidate files directly into the project root until they have passed:
> 1. `node validate_candidate.js` (architectural, layer unit, and weight integrity check).
> 2. `evaluate.html` (held-out validation and test evaluation with full confusion matrix).
> 3. Zero regressions in `node test_gate.js`.

---

## Instructions for Staging
When you export your trained 3-class model from Teachable Machine (TensorFlow.js format):
1. Download the export zip file.
2. Extract the three files into this directory:
   - `candidate_model/model.json`
   - `candidate_model/weights.bin`
   - `candidate_model/metadata.json`
3. Run the candidate validator:
   ```bash
   node validate_candidate.js
   ```
4. Open `evaluate.html` in your browser (via local web server `python -m http.server 8000`) and select the candidate model to benchmark on `data/phase_b/test/`.
5. Only after satisfactory evaluation and approval, follow the promotion procedure documented in `docs/PHASE_B.md`.
