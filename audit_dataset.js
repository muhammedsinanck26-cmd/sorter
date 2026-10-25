/**
 * SEED SORTER — PHASE B: DATASET AUDIT UTILITY
 * ============================================================================
 * Scans, verifies, and audits the local seed dataset:
 *   - Verifies train / validation / test splits
 *   - Validates class directory names against canonical classes
 *   - Counts usable images per class and detects empty or sparse directories
 *   - Flags unsupported files or corrupt entries
 *   - Computes SHA-256 hashes to detect exact duplicate files
 *   - Detects cross-split data leakage (train vs. validation/test)
 *   - Flags cross-class contamination (same hash labeled as multiple classes)
 *   - Analyzes class balance ratios
 *
 * Usage:
 *   node audit_dataset.js
 *   node audit_dataset.js --dir data/phase_b
 *   node audit_dataset.js --json
 * ============================================================================
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// Canonical configuration
const EXPECTED_SPLITS = ['train', 'validation', 'test'];
const CANONICAL_CLASSES = ['pepper_seed', 'papaya_seed', 'other_background'];
const CLASS_ALIASES = {
  pepper: 'pepper_seed',
  pepper_seed: 'pepper_seed',
  papaya: 'papaya_seed',
  papaya_seed: 'papaya_seed',
  background: 'other_background',
  other: 'other_background',
  other_background: 'other_background'
};

const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp']);
const IGNORED_FILES = new Set(['.gitkeep', '.ds_store', 'desktop.ini', 'thumbs.db']);

/** Compute SHA-256 hash of a file */
function hashFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Audit a dataset directory.
 * @param {string} baseDir - Path to data root (e.g. data/phase_b)
 * @returns {object} Audit report
 */
function auditDataset(baseDir) {
  const report = {
    baseDir: path.resolve(baseDir),
    timestamp: new Date().toISOString(),
    exists: false,
    splits: {},
    totals: { totalImages: 0, byClass: {}, bySplit: {} },
    emptyClassDirs: [],
    unrecognizedDirs: [],
    unsupportedFiles: [],
    duplicates: {
      intraSplit: [],   // same file duplicated within same split
      crossSplitLeakage: [], // file in train AND test/validation
      crossClassContamination: [] // file labeled as multiple distinct classes
    },
    warnings: [],
    errors: [],
    status: 'PASS' // 'PASS', 'WARN', 'FAIL', 'EMPTY'
  };

  if (!fs.existsSync(baseDir)) {
    report.errors.push(`Dataset directory does not exist: "${baseDir}".`);
    report.status = 'FAIL';
    return report;
  }

  report.exists = true;

  // Track file hashes: hash -> Array of { split, class, relativePath, fileName }
  const hashMap = new Map();

  for (const cls of CANONICAL_CLASSES) {
    report.totals.byClass[cls] = 0;
  }

  // 1. Check splits
  for (const split of EXPECTED_SPLITS) {
    const splitDir = path.join(baseDir, split);
    report.splits[split] = {
      exists: fs.existsSync(splitDir),
      classes: {},
      totalImages: 0
    };

    if (!report.splits[split].exists) {
      report.warnings.push(`Expected split directory "${split}/" does not exist.`);
      continue;
    }

    const entries = fs.readdirSync(splitDir, { withFileTypes: true });

    // Check for unexpected directories in split
    for (const ent of entries) {
      if (ent.isDirectory()) {
        const canonical = CLASS_ALIASES[ent.name.toLowerCase()];
        if (!canonical) {
          report.unrecognizedDirs.push(path.join(split, ent.name));
          report.warnings.push(`Unrecognized class directory in ${split}: "${ent.name}". Expected one of: [${CANONICAL_CLASSES.join(', ')}].`);
        }
      }
    }

    // Inspect each canonical class
    for (const cls of CANONICAL_CLASSES) {
      // Find actual directory matching canonical name or alias
      let matchedDirName = null;
      for (const ent of entries) {
        if (ent.isDirectory() && CLASS_ALIASES[ent.name.toLowerCase()] === cls) {
          matchedDirName = ent.name;
          break;
        }
      }

      if (!matchedDirName) {
        report.emptyClassDirs.push(path.join(split, cls));
        report.splits[split].classes[cls] = { exists: false, count: 0, files: [] };
        continue;
      }

      const classDirPath = path.join(splitDir, matchedDirName);
      const classFiles = fs.readdirSync(classDirPath, { withFileTypes: true });

      const validFiles = [];
      for (const f of classFiles) {
        if (!f.isFile()) continue;
        const fname = f.name;
        const ext = path.extname(fname).toLowerCase();

        if (IGNORED_FILES.has(fname.toLowerCase())) continue;

        const relPath = path.join(split, matchedDirName, fname);
        const fullPath = path.join(classDirPath, fname);

        if (!SUPPORTED_EXTENSIONS.has(ext)) {
          report.unsupportedFiles.push({ path: relPath, reason: `Unsupported extension "${ext}"` });
          report.warnings.push(`Unsupported non-image file: "${relPath}".`);
          continue;
        }

        try {
          const hash = hashFile(fullPath);
          const stat = fs.statSync(fullPath);
          const fileInfo = { split, class: cls, relPath, fileName: fname, sizeBytes: stat.size, hash };
          validFiles.push(fileInfo);

          if (!hashMap.has(hash)) {
            hashMap.set(hash, []);
          }
          hashMap.get(hash).push(fileInfo);
        } catch (err) {
          report.errors.push(`Unreadable image file "${relPath}": ${err.message}`);
        }
      }

      report.splits[split].classes[cls] = {
        exists: true,
        actualDirName: matchedDirName,
        count: validFiles.length
      };

      report.splits[split].totalImages += validFiles.length;
      report.totals.totalImages += validFiles.length;
      report.totals.byClass[cls] += validFiles.length;

      if (validFiles.length === 0) {
        report.emptyClassDirs.push(path.join(split, matchedDirName));
      }
    }

    report.totals.bySplit[split] = report.splits[split].totalImages;
  }

  // 2. Hash Duplicate & Leakage Analysis
  for (const [hash, occurrences] of hashMap.entries()) {
    if (occurrences.length > 1) {
      // Check for distinct splits
      const splits = new Set(occurrences.map(o => o.split));
      const classes = new Set(occurrences.map(o => o.class));

      // Cross-class contamination: same exact file in pepper AND papaya or background!
      if (classes.size > 1) {
        report.duplicates.crossClassContamination.push({
          hash: hash.slice(0, 12),
          classes: Array.from(classes),
          files: occurrences.map(o => o.relPath)
        });
        report.errors.push(`CRITICAL DATA CONTAMINATION: Exact duplicate image filed under multiple classes: [${occurrences.map(o => o.relPath).join(', ')}].`);
      }

      // Cross-split leakage: same file in train AND test/validation
      if (splits.has('train') && (splits.has('test') || splits.has('validation'))) {
        report.duplicates.crossSplitLeakage.push({
          hash: hash.slice(0, 12),
          splits: Array.from(splits),
          files: occurrences.map(o => o.relPath)
        });
        report.errors.push(`DATA LEAKAGE: Image appears in both training and evaluation split: [${occurrences.map(o => o.relPath).join(', ')}].`);
      } else if (splits.size === 1) {
        report.duplicates.intraSplit.push({
          hash: hash.slice(0, 12),
          split: occurrences[0].split,
          files: occurrences.map(o => o.relPath)
        });
      }
    }
  }

  // 3. Dataset sufficiency & balance checks
  if (report.totals.totalImages === 0) {
    report.status = 'EMPTY';
    report.warnings.push('Dataset contains 0 valid image files. Directory structure is initialized, waiting for image capture.');
  } else {
    // Check training class sizes
    const trainCounts = CANONICAL_CLASSES.map(c => report.splits.train?.classes[c]?.count || 0);
    const minTrain = Math.min(...trainCounts);
    const maxTrain = Math.max(...trainCounts);

    if (minTrain === 0) {
      report.warnings.push('One or more training classes have 0 images. Cannot train a 3-class model.');
      report.status = 'WARN';
    } else if (minTrain < 30) {
      report.warnings.push(`Minimum class count in train is ${minTrain} < 30 (Teachable Machine recommended minimum is 30/class).`);
      if (report.status === 'PASS') report.status = 'WARN';
    }

    if (minTrain > 0 && maxTrain / minTrain > 3.0) {
      report.warnings.push(`Severe class imbalance in training split: ratio is ${(maxTrain / minTrain).toFixed(1)}:1 (max=${maxTrain}, min=${minTrain}).`);
      if (report.status === 'PASS') report.status = 'WARN';
    }

    // Check test split
    const testCounts = CANONICAL_CLASSES.map(c => report.splits.test?.classes[c]?.count || 0);
    if (testCounts.some(c => c === 0)) {
      report.warnings.push('Held-out test split is missing images for one or more classes.');
      if (report.status === 'PASS') report.status = 'WARN';
    }
  }

  if (report.errors.length > 0) {
    report.status = 'FAIL';
  }

  return report;
}

/** CLI Output Formatter */
function printReport(report) {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  SEED SORTER — PHASE B DATASET AUDIT REPORT');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  Path:      ${report.baseDir}`);
  console.log(`  Status:    ${report.status === 'PASS' ? '✅ PASS' : (report.status === 'EMPTY' ? '⚠️  EMPTY (Awaiting Capture)' : (report.status === 'WARN' ? '⚠️  WARNINGS' : '❌ FAIL'))}`);
  console.log(`  Total:     ${report.totals.totalImages} images`);
  console.log('──────────────────────────────────────────────────────────────');
  console.log('  SPLIT & CLASS BREAKDOWN:');
  console.log('──────────────────────────────────────────────────────────────');

  for (const split of EXPECTED_SPLITS) {
    const sData = report.splits[split];
    if (!sData || !sData.exists) {
      console.log(`  [${split.toUpperCase()}] — Directory Missing`);
      continue;
    }
    console.log(`  📁 [${split.toUpperCase()}] (Total: ${sData.totalImages})`);
    for (const cls of CANONICAL_CLASSES) {
      const cData = sData.classes[cls];
      const count = cData ? cData.count : 0;
      const indicator = count >= 100 ? '✅' : (count >= 30 ? '🟡' : (count > 0 ? '⚠️' : '⚪'));
      console.log(`      ${indicator} ${cls.padEnd(18)} : ${count} images`);
    }
  }

  console.log('──────────────────────────────────────────────────────────────');
  console.log('  DATA INTEGRITY CHECKS:');
  console.log('──────────────────────────────────────────────────────────────');
  console.log(`  • Cross-split data leakage:       ${report.duplicates.crossSplitLeakage.length === 0 ? '✅ None' : '❌ ' + report.duplicates.crossSplitLeakage.length + ' LEAKS DETECTED'}`);
  console.log(`  • Cross-class label contamination:${report.duplicates.crossClassContamination.length === 0 ? '✅ None' : '❌ ' + report.duplicates.crossClassContamination.length + ' CONTAMINATIONS'}`);
  console.log(`  • Intra-split exact duplicates:   ${report.duplicates.intraSplit.length === 0 ? '✅ None' : '⚠️ ' + report.duplicates.intraSplit.length + ' duplicates'}`);
  console.log(`  • Unsupported files:              ${report.unsupportedFiles.length === 0 ? '✅ None' : '⚠️ ' + report.unsupportedFiles.length + ' files'}`);

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
  let baseDir = 'data/phase_b';
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir' && args[i + 1]) {
      baseDir = args[i + 1];
      i++;
    } else if (args[i] === '--json') {
      jsonOutput = true;
    }
  }

  const report = auditDataset(baseDir);

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  process.exit(report.status === 'FAIL' ? 1 : 0);
}

module.exports = { auditDataset, CANONICAL_CLASSES, EXPECTED_SPLITS };
