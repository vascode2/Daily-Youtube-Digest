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
const rawFile = path.join(tmpDir, `raw-${key}.json`);

console.log(`🔍 Reviewing: ${path.basename(summariesFile)}\n`);

let content = fs.readFileSync(summariesFile, 'utf8');
const rawItems = fs.existsSync(rawFile) ? JSON.parse(fs.readFileSync(rawFile, 'utf8')) : [];
const rawByVideoId = new Map(rawItems.map(item => [item.videoId, item]));

const issues = [];
let errorCount = 0;
let fixCount = 0;

const alwaysRequired = ['핵심 요약', '한 줄 인사이트'];
const transcriptOnlyRequired = ['주요 타임라인']; // only required when transcript is available
// Split on standalone --- separators (not table separators like |---|)
// Video blocks are identified by their h2 title with a link: `## [Title](url)`
// Channel headers (### 📺 @handle) are NOT video blocks — they're metadata
const videoBlocks = content.split(/\n---\s*\n/).filter(b => /^##\s+\[/m.test(b));

for (const block of videoBlocks) {
  // Title is the first `## [Title](url)` line
  const titleMatch = block.match(/^##\s+\[([^\]]+)\]/m);
  if (!titleMatch) continue;
  const title = titleMatch[1].trim();
  const urlMatch = block.match(/^##\s+\[[^\]]+\]\((https?:\/\/www\.youtube\.com\/watch\?v=([^\s)]+))\)/m);
  const videoId = urlMatch ? urlMatch[2] : null;
  const raw = videoId ? rawByVideoId.get(videoId) : null;

  for (const section of alwaysRequired) {
    if (!block.includes(section)) {
      issues.push({ level: 'ERROR', video: title, check: 'missing_section', detail: `Missing: ${section}` });
      errorCount++;
      console.log(`  ❌ ERROR: "${title}" — missing section: ${section}`);
    }
  }
  // 주요 타임라인 is optional — only warn if missing (often unavailable for videos without transcripts)
  for (const section of transcriptOnlyRequired) {
    if ((raw?.hasTranscript || ((raw?.transcriptSegments || []).length >= 3)) && !block.includes(section)) {
      issues.push({ level: 'ERROR', video: title, check: 'missing_section', detail: `Missing: ${section}` });
      errorCount++;
      console.log(`  ❌ ERROR: "${title}" — missing section: ${section} (transcript available)`);
    } else if (!raw?.hasTranscript && !block.includes(section)) {
      issues.push({ level: 'WARNING', video: title, check: 'missing_section', detail: `Missing: ${section}` });
    }
  }

  const summaryText = extractSectionBody(block, '핵심 요약', ['주요 타임라인']);
  const summaryParagraphs = splitParagraphs(summaryText);
  if (summaryParagraphs.length < 2 || summaryParagraphs.length > 3) {
    issues.push({
      level: 'ERROR',
      video: title,
      check: 'summary_paragraph_count',
      detail: `핵심 요약 must be 2-3 paragraphs (found ${summaryParagraphs.length})`
    });
    errorCount++;
    console.log(`  ❌ ERROR: "${title}" — 핵심 요약 문단 수 ${summaryParagraphs.length}`);
  }

  const normalizedSummary = summaryParagraphs.join(' ');
  if (!looksMostlyKorean(normalizedSummary)) {
    issues.push({
      level: 'ERROR',
      video: title,
      check: 'summary_language',
      detail: '핵심 요약 must be primarily Korean'
    });
    errorCount++;
    console.log(`  ❌ ERROR: "${title}" — 핵심 요약 언어가 한국어 중심이 아님`);
  }

  if (!/(예를 들어|예시|사례|데모|실험|비교)/.test(normalizedSummary)) {
    issues.push({
      level: 'ERROR',
      video: title,
      check: 'summary_examples',
      detail: '핵심 요약 must include at least one concrete example/demo/case'
    });
    errorCount++;
    console.log(`  ❌ ERROR: "${title}" — 핵심 요약에 사례/데모가 없음`);
  }

  const timestamps = block.match(/\[\d+:\d+:\d+\]/g) || [];
  const badTimestamps = block.match(/\[\d+:\d+\](?!:)/g) || [];
  if (badTimestamps.length > timestamps.length) {
    content = content.replace(/\[(\d+):(\d+)\](?!:)/g, (_, m, s) => `[00:${m.padStart(2,'0')}:${s.padStart(2,'0')}]`);
    issues.push({ level: 'WARNING', video: title, check: 'timestamp_format', detail: 'Auto-fixed MM:SS → HH:MM:SS', fixed: true });
    fixCount++;
    console.log(`  🔧 Fixed timestamp format in: "${title}"`);
  }

  const timelineBody = extractSectionBody(block, '주요 타임라인', []);
  const timelineLines = timelineBody.split('\n').map(l => l.trim()).filter(l => l.startsWith('- '));
  const timelineSec = [];
  let timelineMalformed = false;

  for (const line of timelineLines) {
    const m = line.match(/^-\s*\[(\d{2}:\d{2}:\d{2})\]\s*(.+)$/);
    if (!m) {
      timelineMalformed = true;
      continue;
    }
    timelineSec.push(parseHms(m[1]));
  }

  if (timelineLines.length > 0 && timelineMalformed) {
    issues.push({ level: 'ERROR', video: title, check: 'timeline_format', detail: 'Timeline lines must be `- [HH:MM:SS] content` or `- [HH:MM:SS](URL) content`' });
    errorCount++;
  }

  if ((raw?.transcriptSegments || []).length >= 3 && timelineLines.length < 3) {
    issues.push({ level: 'ERROR', video: title, check: 'timeline_length', detail: `Expected at least 3 timeline entries (found ${timelineLines.length})` });
    errorCount++;
  }

  if (raw?.duration && timelineSec.some(t => t > raw.duration)) {
    issues.push({ level: 'ERROR', video: title, check: 'timeline_out_of_range', detail: 'Timeline contains timestamp beyond video duration' });
    errorCount++;
  }

  if (!isSorted(timelineSec)) {
    issues.push({ level: 'WARNING', video: title, check: 'timeline_order', detail: 'Timeline timestamps are not ascending' });
  }

  if ((raw?.transcriptSegments || []).length >= 3 && timelineSec.length > 0) {
    const segmentSec = raw.transcriptSegments.map(s => parseHms(s.start));
    const unmatched = timelineSec.filter(t => !segmentSec.some(s => Math.abs(s - t) <= 120));
    if (unmatched.length > 0) {
      issues.push({ level: 'WARNING', video: title, check: 'timeline_alignment', detail: 'Some timeline timestamps do not align with transcript segments (±120s)' });
    }
  }

  if (!(raw?.transcriptSegments || []).length && timelineLines.length > 0) {
    issues.push({ level: 'WARNING', video: title, check: 'timeline_source', detail: 'Timeline present without transcriptSegments; accuracy may be low' });
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

if (!/###\s+📺\s+/.test(content)) {
  issues.push({ level: 'ERROR', check: 'structure', detail: 'No channel sections found (### 📺 ChannelName)' });
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

function extractSectionBody(block, sectionTitle, nextSections = []) {
  const escaped = sectionTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const next = nextSections
    .map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');

  const re = next
    ? new RegExp(`\\*\\*${escaped}\\*\\*\\s*\\n([\\s\\S]*?)(?=\\n\\*\\*(?:${next})\\*\\*|$)`)
    : new RegExp(`\\*\\*${escaped}\\*\\*\\s*\\n([\\s\\S]*?)$`);

  const m = block.match(re);
  return m ? m[1].trim() : '';
}

function splitParagraphs(text) {
  if (!text) return [];
  const unquoted = text
    .split('\n')
    .map(line => line.replace(/^>\s?/, ''))
    .join('\n')
    .trim();

  return unquoted
    .split(/\n\s*\n/)
    .map(p => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function looksMostlyKorean(text) {
  const hangul = (text.match(/[가-힣]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  if (!text.trim()) return false;
  return hangul >= Math.max(30, latin * 1.1);
}

function parseHms(hms) {
  const [h, m, s] = hms.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

function isSorted(values) {
  for (let i = 1; i < values.length; i++) {
    if (values[i] < values[i - 1]) return false;
  }
  return true;
}

function findLatestSummaries(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith('summaries-') && f.endsWith('.md'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length > 0 ? path.join(dir, files[0].name) : null;
}
