#!/usr/bin/env node
/**
 * review.js — Quality check and auto-fix summaries
 * Reads: tmp/summaries-YYYY-MM-DD.md, tmp/raw-YYYY-MM-DD.json
 * Writes: tmp/review-report-YYYY-MM-DD.json, modifies summaries file in-place
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const dateStr = getYesterdayStr();
const summariesFile = path.join(ROOT, 'tmp', `summaries-${dateStr}.md`);
const rawFile = path.join(ROOT, 'tmp', `raw-${dateStr}.json`);
const reportFile = path.join(ROOT, 'tmp', `review-report-${dateStr}.json`);

if (!fs.existsSync(summariesFile)) {
  console.error(`❌ No summaries found: ${summariesFile}\nRun summarize.js first.`);
  process.exit(1);
}

let content = fs.readFileSync(summariesFile, 'utf8');
const rawVideos = fs.existsSync(rawFile) ? JSON.parse(fs.readFileSync(rawFile, 'utf8')) : [];

const issues = [];
let errorCount = 0;
let fixCount = 0;

console.log('🔍 Reviewing summaries...\n');

// Check 1: Required sections present
const requiredSections = ['핵심 요약', '주요 타임라인', '한 줄 인사이트'];
// Split on standalone --- separators (not table separators like |---|)
const videoBlocks = content.split(/\n---\s*\n/).filter(b => /^###\s/m.test(b));

for (const block of videoBlocks) {
  const titleMatch = block.match(/###\s+(.+)/);
  if (!titleMatch) continue;
  const title = titleMatch[1].trim();

  for (const section of requiredSections) {
    if (!block.includes(section)) {
      issues.push({ level: 'ERROR', video: title, check: 'missing_section', detail: `Missing: ${section}` });
      errorCount++;
      console.log(`  ❌ ERROR: "${title}" — missing section: ${section}`);
    }
  }

  // Check 2: Timestamp format
  const timestamps = block.match(/\[\d+:\d+:\d+\]/g) || [];
  const badTimestamps = block.match(/\[\d+:\d+\]/g) || []; // MM:SS instead of HH:MM:SS
  if (badTimestamps.length > timestamps.length) {
    // Auto-fix: convert MM:SS to HH:MM:SS
    content = content.replace(/\[(\d+):(\d+)\]/g, (_, m, s) => `[00:${m.padStart(2,'0')}:${s.padStart(2,'0')}]`);
    issues.push({ level: 'WARNING', video: title, check: 'timestamp_format', detail: 'Auto-fixed MM:SS → HH:MM:SS', fixed: true });
    fixCount++;
    console.log(`  🔧 Fixed timestamp format in: "${title}"`);
  }

  // Check 3: 한 줄 인사이트 length (should be 1 sentence)
  const insightMatch = block.match(/한 줄 인사이트[^\n]*\n(.*)/);
  if (insightMatch) {
    const insight = insightMatch[1].trim();
    const sentences = insight.split(/[.。!?！？]/).filter(s => s.trim()).length;
    if (sentences > 2) {
      issues.push({ level: 'WARNING', video: title, check: 'insight_length', detail: `Too long: ${sentences} sentences` });
      console.log(`  ⚠️  WARNING: "${title}" — 한 줄 인사이트 too long (${sentences} sentences)`);
    }
  }
}

// Check 4: Overall document structure
if (!content.includes('## @')) {
  issues.push({ level: 'ERROR', check: 'structure', detail: 'No channel sections found (## @handle)' });
  errorCount++;
}

// Save fixed content
fs.writeFileSync(summariesFile, content);

// Save report
const report = {
  date: dateStr,
  totalIssues: issues.length,
  errors: errorCount,
  warnings: issues.length - errorCount,
  autoFixed: fixCount,
  issues
};

fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));

console.log(`\n📊 Review Report:`);
console.log(`   Issues: ${issues.length} (${errorCount} errors, ${issues.length - errorCount} warnings)`);
console.log(`   Auto-fixed: ${fixCount}`);
console.log(`   Report: ${reportFile}`);

if (errorCount > 0) {
  console.error(`\n❌ ${errorCount} error(s) require manual attention.`);
  process.exit(1);
} else {
  console.log('\n✅ Review passed.');
}

function getYesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}
