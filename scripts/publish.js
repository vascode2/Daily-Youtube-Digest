#!/usr/bin/env node
/**
 * publish.js — Save the latest summaries from tmp/ to output/ and Notion
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const tmpDir = path.join(ROOT, 'tmp');
const outputDir = path.join(ROOT, 'output');

const summariesFile = findLatestSummaries(tmpDir);
if (!summariesFile) {
  console.error(`❌ No summaries-*.md found in ${tmpDir}`);
  process.exit(1);
}

const key = path.basename(summariesFile).replace(/^summaries-/, '').replace(/\.md$/, '');
const reportFile = path.join(tmpDir, `review-report-${key}.json`);
const outputFile = path.join(outputDir, `${key}.md`);

const isRange = key.includes('_to_');
const [startStr, endStr] = isRange ? key.split('_to_') : [key, key];

fs.mkdirSync(outputDir, { recursive: true });

const now = new Date();
const timeStr = now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : {};
const summaries = fs.readFileSync(summariesFile, 'utf8');

const channelCount = (summaries.match(/^## @/gm) || []).length;
const videoCount = (summaries.match(/^### /gm) || []).length;

const titleHeading = isRange
  ? `# 📺 YouTube Weekly Digest — ${formatDateKo(startStr)} ~ ${formatDateKo(endStr)}`
  : `# 📺 YouTube Digest — ${formatDateKo(endStr)}`;

const header = `${titleHeading}

> 생성: ${timeStr} | 채널: ${channelCount}개 | 영상: ${videoCount}개${report.errors > 0 ? ` | ⚠️ 리뷰 오류: ${report.errors}건` : ''}

---
`;

const finalContent = header + summaries.replace(/^# YouTube.*\n\n/, '');
fs.writeFileSync(outputFile, finalContent);
console.log(`✅ Saved: ${outputFile}`);

const notionToken = process.env.NOTION_TOKEN;
const notionPageId = process.env.NOTION_PAGE_ID;

let notionUrl = 'SKIPPED (no NOTION_TOKEN/NOTION_PAGE_ID set)';

if (notionToken && notionPageId) {
  console.log('📝 Publishing to Notion...');
  try {
    const blocks = markdownToNotionBlocks(finalContent);
    console.log(`   Converted to ${blocks.length} Notion blocks`);

    const notionTitle = isRange
      ? `📺 Weekly Digest ${startStr} ~ ${endStr}`
      : `📺 YouTube Digest ${endStr}`;

    const firstBatch = blocks.slice(0, 100);
    const restBatches = [];
    for (let i = 100; i < blocks.length; i += 100) {
      restBatches.push(blocks.slice(i, i + 100));
    }

    const createRes = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: notionHeaders(notionToken),
      body: JSON.stringify({
        parent: { page_id: notionPageId },
        properties: { title: { title: [{ text: { content: notionTitle } }] } },
        children: firstBatch
      })
    });

    if (!createRes.ok) {
      const err = await createRes.text();
      throw new Error(`${createRes.status}: ${err}`);
    }

    const createdPage = await createRes.json();
    const newPageId = createdPage.id;

    for (const batch of restBatches) {
      const r = await fetch(`https://api.notion.com/v1/blocks/${newPageId}/children`, {
        method: 'PATCH',
        headers: notionHeaders(notionToken),
        body: JSON.stringify({ children: batch })
      });
      if (!r.ok) console.error(`   ⚠️  Append failed: ${r.status}`);
    }

    notionUrl = createdPage.url;
    console.log(`   ✅ Notion: ${notionUrl}`);
  } catch (err) {
    console.error(`   ❌ Notion failed: ${err.message}`);
    notionUrl = `FAILED: ${err.message.slice(0, 100)}`;
  }
}

if (fs.existsSync(tmpDir)) {
  fs.readdirSync(tmpDir)
    .filter(f => f.includes(key))
    .forEach(f => fs.unlinkSync(path.join(tmpDir, f)));
  console.log('🧹 Cleaned tmp files');
}

console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ ${isRange ? 'Weekly digest' : 'Digest'} complete!
📄 File:    output/${key}.md
📊 Stats:   채널 ${channelCount}개 | 영상 ${videoCount}개 | 오류 ${report.errors || 0}건
📝 Notion:  ${notionUrl}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

// ── helpers ──────────────────────────────────────────────────

function findLatestSummaries(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith('summaries-') && f.endsWith('.md'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length > 0 ? path.join(dir, files[0].name) : null;
}

function notionHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Notion-Version': '2022-06-28'
  };
}

function formatDateKo(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${y}.${m}.${d}`;
}

function markdownToNotionBlocks(md) {
  const blocks = [];
  const lines = md.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) { i++; continue; }

    if (trimmed === '---') {
      blocks.push({ object: 'block', type: 'divider', divider: {} });
      i++; continue;
    }
    if (trimmed.startsWith('# ')) { blocks.push(headingBlock(1, trimmed.slice(2))); i++; continue; }
    if (trimmed.startsWith('## ')) { blocks.push(headingBlock(2, trimmed.slice(3))); i++; continue; }
    if (trimmed.startsWith('### ')) { blocks.push(headingBlock(3, trimmed.slice(4))); i++; continue; }

    if (trimmed.startsWith('> ')) {
      blocks.push({
        object: 'block', type: 'quote',
        quote: { rich_text: parseRichText(trimmed.slice(2)) }
      });
      i++; continue;
    }
    if (trimmed.startsWith('- ')) {
      blocks.push({
        object: 'block', type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: parseRichText(trimmed.slice(2)) }
      });
      i++; continue;
    }
    if (trimmed.startsWith('|')) {
      const tableLines = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        tableLines.push(lines[i].trim());
        i++;
      }
      const cleaned = tableLines.filter(l => !/^\|[\s\-:|]+\|$/.test(l));
      blocks.push({
        object: 'block', type: 'code',
        code: {
          rich_text: [{ type: 'text', text: { content: cleaned.join('\n').slice(0, 2000) } }],
          language: 'plain text'
        }
      });
      continue;
    }

    blocks.push({
      object: 'block', type: 'paragraph',
      paragraph: { rich_text: parseRichText(trimmed) }
    });
    i++;
  }
  return blocks;
}

function headingBlock(level, text) {
  const type = `heading_${level}`;
  return { object: 'block', type, [type]: { rich_text: parseRichText(text) } };
}

function parseRichText(text) {
  const parts = [];
  const regex = /\*\*([^*]+)\*\*/g;
  let lastIndex = 0;
  let m;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > lastIndex) parts.push(plainSegment(text.slice(lastIndex, m.index)));
    parts.push(boldSegment(m[1]));
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) parts.push(plainSegment(text.slice(lastIndex)));
  return parts.length > 0 ? parts : [plainSegment(text)];
}

function plainSegment(t) { return { type: 'text', text: { content: t.slice(0, 2000) } }; }
function boldSegment(t)  { return { type: 'text', text: { content: t.slice(0, 2000) }, annotations: { bold: true } }; }
