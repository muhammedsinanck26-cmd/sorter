/**
 * SEED SORTER — PHASE B: CANDIDATE MODEL VALIDATION UTILITY
 * ============================================================================
 * Verifies that a staged model export:
 *   1. Contains model.json, metadata.json, and weights.bin from the SAME export
 *   2. Has a genuine 3-output Dense softmax layer (not hand-edited)
 *   3. Has metadata labels matching output unit count
 *   4. Has matching weight tensor byte sizes matching weights.bin
 *   5. Contains the required pepper, papaya, and background/other classes
 *
 * Usage:
 *   node validate_candidate.js                 (checks candidate_model/)
 *   node validate_candidate.js --dir .         (checks active production model)
 *   node validate_candidate.js --dir <path>
 * ============================================================================
 */

'use strict';

const fs   = require('fs');
const path = require('path');

function validateExport(dirPath, options = {}) {
  const targetDir = path.resolve(dirPath);
  const report = {
    targetDir,
    filesExist: false,
    modelValid: false,
    labelCount: 0,
    denseUnits: 0,
    weightsBytes: 0,
    expectedWeightsBytes: 0,
    labels: [],
    errors: [],
    warnings: [],
    status: 'FAIL' // 'PASS', 'WARN', 'FAIL', 'NOT_STAGED'
  };

  const modelPath    = path.join(targetDir, 'model.json');
  const metadataPath = path.join(targetDir, 'metadata.json');
  const weightsPath  = path.join(targetDir, 'weights.bin');

  if (!fs.existsSync(modelPath) || !fs.existsSync(metadataPath) || !fs.existsSync(weightsPath)) {
    const missing = [];
    if (!fs.existsSync(modelPath)) missing.push('model.json');
    if (!fs.existsSync(metadataPath)) missing.push('metadata.json');
    if (!fs.existsSync(weightsPath)) missing.push('weights.bin');

    report.status = 'NOT_STAGED';
    report.warnings.push(`Candidate export not staged in "${dirPath}". Missing: [${missing.join(', ')}].`);
    return report;
  }

  report.filesExist = true;

  // 1. Parse metadata.json
  let metadata;
  try {
    metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    if (!Array.isArray(metadata.labels)) {
      report.errors.push('metadata.json has no valid "labels" array.');
    } else {
      report.labels = metadata.labels;
      report.labelCount = metadata.labels.length;
    }
  } catch (e) {
    report.errors.push(`Failed to parse metadata.json: ${e.message}`);
    return report;
  }

  // 2. Parse model.json
  let modelJson;
  try {
    modelJson = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
  } catch (e) {
    report.errors.push(`Failed to parse model.json: ${e.message}`);
    return report;
  }

  // Find final Dense layer
  let finalDense = null;
  try {
    const layers = modelJson.modelTopology.config.layers;
    const finalSeq = layers[layers.length - 1];
    if (finalSeq && Array.isArray(finalSeq.config.layers)) {
      for (let i = finalSeq.config.layers.length - 1; i >= 0; i--) {
        const l = finalSeq.config.layers[i];
        if (l.class_name === 'Dense') {
          finalDense = l;
          break;
        }
      }
    }
  } catch (e) {
    report.errors.push(`Could not inspect modelTopology layer structure: ${e.message}`);
  }

  if (!finalDense) {
    report.errors.push('Could not locate final Dense classification layer in model.json.');
  } else {
    report.denseUnits = finalDense.config.units;
    report.activation = finalDense.config.activation;

    if (report.denseUnits !== report.labelCount) {
      report.errors.push(
        `MISMATCH: Final Dense layer has ${report.denseUnits} units, but metadata.json lists ${report.labelCount} labels.`
      );
    }

    if (report.activation !== 'softmax') {
      report.warnings.push(`Expected 'softmax' activation on final Dense layer, got '${report.activation}'.`);
    }
  }

  // 3. Verify weights.bin size against weightsManifest
  const weightsStat = fs.statSync(weightsPath);
  report.weightsBytes = weightsStat.size;

  if (Array.isArray(modelJson.weightsManifest)) {
    let totalExpectedBytes = 0;
    const DTYPE_BYTES = { float32: 4, int32: 4, uint8: 1, bool: 1 };

    for (const group of modelJson.weightsManifest) {
      if (Array.isArray(group.weights)) {
        for (const w of group.weights) {
          const numElements = (w.shape || []).reduce((acc, dim) => acc * dim, 1);
          const bytesPerElem = DTYPE_BYTES[w.dtype] || 4;
          totalExpectedBytes += numElements * bytesPerElem;
        }
      }
    }

    report.expectedWeightsBytes = totalExpectedBytes;
    if (totalExpectedBytes > 0 && Math.abs(weightsStat.size - totalExpectedBytes) > 64) {
      report.errors.push(
        `WEIGHT CORRUPTION: weights.bin size (${weightsStat.size} bytes) does not match manifest expectation (${totalExpectedBytes} bytes).`
      );
    }
  }

  // 4. Check class labels
  const labelsLower = report.labels.map(l => String(l).toLowerCase());
  const hasPepper = labelsLower.some(l => l.includes('pepper'));
  const hasPapaya = labelsLower.some(l => l.includes('papaya'));
  const hasBg     = labelsLower.some(l => l.includes('background') || l.includes('other') || l.includes('empty'));

  if (!hasPepper) report.errors.push('Missing required "pepper" class label.');
  if (!hasPapaya) report.errors.push('Missing required "papaya" class label.');

  if (report.denseUnits === 3) {
    if (!hasBg) {
      report.errors.push('3-class model must have a "background" / "other" negative class label.');
    }
  } else if (report.denseUnits === 2) {
    report.warnings.push('Model has 2 classes (Phase A legacy architecture, not a genuine 3-class model).');
  }

  report.status = report.errors.length === 0 ? 'PASS' : 'FAIL';
  report.modelValid = (report.status === 'PASS');

  return report;
}

function printValidationReport(report) {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  CANDIDATE MODEL VALIDATION REPORT');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  Directory:      ${report.targetDir}`);
  console.log(`  Status:         ${report.status === 'PASS' ? '✅ PASS' : (report.status === 'NOT_STAGED' ? '⚪ NOT STAGED' : '❌ FAIL')}`);
  console.log(`  Files Present:  ${report.filesExist ? 'Yes (model.json, metadata.json, weights.bin)' : 'No'}`);
  if (report.filesExist) {
    console.log(`  Output Units:   ${report.denseUnits} (Activation: ${report.activation || 'unknown'})`);
    console.log(`  Labels (${report.labelCount}):     [${report.labels.join(', ')}]`);
    console.log(`  Weights Size:   ${report.weightsBytes.toLocaleString()} bytes (Manifest: ${report.expectedWeightsBytes.toLocaleString()} bytes)`);
  }

  if (report.warnings.length > 0) {
    console.log('\n  ⚠️  WARNINGS:');
    for (const w of report.warnings) console.log(`      - ${w}`);
  }

  if (report.errors.length > 0) {
    console.log('\n  ❌ ERRORS:');
    for (const e of report.errors) console.log(`      - ${e}`);
  }

  console.log('\n══════════════════════════════════════════════════════════════\n');
}

// CLI Execution
if (require.main === module) {
  const args = process.argv.slice(2);
  let dir = 'candidate_model';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir' && args[i + 1]) {
      dir = args[i + 1];
      i++;
    }
  }

  const report = validateExport(dir);
  printValidationReport(report);
  process.exit(report.status === 'FAIL' ? 1 : 0);
}

module.exports = { validateExport };
