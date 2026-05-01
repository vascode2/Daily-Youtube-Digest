#!/usr/bin/env node
/**
 * review.js — Quality check and auto-fix the most recent summaries file in tmp/
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const tmpDir = path.join(ROOT, 'tmp');

const summariesFile = findLatestSummaries(tmpDir);
if (!summariesFile) {
  console.error(`❌ No summaries-*.md found in ${tmpDir}`);
  process.exit(1);
}

const key = path.basename(summariesFile).replace(/^summaries-/, '').replace(/\.md$/, '');
const reportFile = path.join(tmpDir, `review-report-${key}.json`);

console.log(`🔍 Reviewing: ${path.basename(summariesFile)}\n`);

let content = fs.readFileSync(summariesFile, 'utf8');

const issues = [];
let errorCount = 0;
let fixCount = 0;

const alwaysRequired = ['핵심 요약', '한 줄 인사이트'];
const transcriptOnlyRequired = ['주요 타임라인']; // only required when transcript is available
// Split on standalone --- separators (not table separators like |---|)
const videoBlocks = content.split(/\n---\s*\n/).filter(b => /^###\s/m.test(b));

for (const block of videoBlocks) {
  const titleMatch = block.match(/###\s+(.+)/);
  if (!titleMatch) continue;
  const title = titleMatch[1].trim();

  const hasTranscript = !/자막\s*\|\s*없음/.test(block);

  for (const section of alwaysRequired) {
    if (!block.includes(section)) {
      issues.push({ level: 'ERROR', video: title, check: 'missing_section', detail: `Missing: ${section}` });
      errorCount++;
      console.log(`  ❌ ERROR: "${title}" — missing section: ${section}`);
    }
  }
  for (const section of transcriptOnlyRequired) {
    if (!block.includes(section)) {
      const level = hasTranscript ? 'ERROR' : 'WARNING';
      issues.push({ level, video: title, check: 'missing_section', detail: `Missing: ${section}` });
      if (hasTranscript) {
        errorCount++;
        console.log(`  ❌ ERROR: "${title}" — missing section: ${section}`);
      } else {
        console.log(`  ⚠️  WARNING: "${title}" — missing section: ${section} (no transcript)`);
      }
    }
  }

  const timestamps = block.match(/\[\d+:\d+:\d+\]/g) || [];
  const badTimestamps = block.match(/\[\d+:\d+\](?!:)/g) || [];
  if (badTimestamps.length > timestamps.length) {
    content = content.replace(/\[(\d+):(\d+)\](?!:)/g, (_, m, s) => `[00:${m.padStart(2,'0')}:${s.padStart(2,'0')}]`);
    issues.push({ level: 'WARNING', video: title, check: 'timestamp_format', detail: 'Auto-fixed MM:SS → HH:MM:SS', fixed: true });
    fixCount++;
    console.log(`  🔧 Fixed timestamp format in: "${title}"`);
  }

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

if (!content.includes('## @')) {
  issues.push({ level: 'ERROR', check: 'structure', detail: 'No channel sections found (## @handle)' });
  errorCount++;
}

fs.writeFileSync(summariesFile, content);

const report = {
  key,
  totalIssues: issues.length,
  errors: errorCount,
  warnings: issues.length - errorCount,
  autoFixed: fixCount,
  issues
};
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));

console.log(`\n📊 Review: ${issues.length} issues (${errorCount} errors, ${issues.length - errorCount} warnings), ${fixCount} auto-fixed`);

if (errorCount > 0) {
  console.error(`❌ ${errorCount} error(s) require manual attention.`);
  process.exit(1);
}
console.log('✅ Review passed.');

function findLatestSummaries(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith('summaries-') && f.endsWith('.md'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length > 0 ? path.join(dir, files[0].name) : null;
}
