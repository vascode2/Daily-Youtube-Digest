#!/usr/bin/env node
/**
 * publish.js — Save final digest to output/ and optionally Notion
 * Reads: tmp/summaries-YYYY-MM-DD.md, tmp/review-report-YYYY-MM-DD.json
 * Writes: output/YYYY-MM-DD.md, optionally Notion page
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const dateStr = getYesterdayStr();
const summariesFile = path.join(ROOT, 'tmp', `summaries-${dateStr}.md`);
const reportFile = path.join(ROOT, 'tmp', `review-report-${dateStr}.json`);
const outputDir = path.join(ROOT, 'output');
const outputFile = path.join(outputDir, `${dateStr}.md`);

if (!fs.existsSync(summariesFile)) {
  console.error(`❌ No summaries to publish: ${summariesFile}`);
  process.exit(1);
}

fs.mkdirSync(outputDir, { recursive: true });

const now = new Date();
const timeStr = now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : {};
const summaries = fs.readFileSync(summariesFile, 'utf8');

const channelCount = (summaries.match(/^## @/gm) || []).length;
const videoCount = (summaries.match(/^### /gm) || []).length;

const header = `# 📺 YouTube Digest — ${formatDateKo(dateStr)}

> 생성: ${timeStr} | 채널: ${channelCount}개 | 영상: ${videoCount}개${report.errors > 0 ? ` | ⚠️ 리뷰 오류: ${report.errors}건` : ''}

---
`;

const finalContent = header + summaries.replace(/^# YouTube Digest.*\n\n/, '');
fs.writeFileSync(outputFile, finalContent);
console.log(`✅ Saved: ${outputFile}`);

// Notion publish
const notionToken = process.env.NOTION_TOKEN;
const notionPageId = process.env.NOTION_PAGE_ID;

let notionUrl = 'SKIPPED (no NOTION_TOKEN/NOTION_PAGE_ID set)';

if (notionToken && notionPageId) {
  console.log('📝 Publishing to Notion...');
  try {
    const blocks = markdownToNotionBlocks(finalContent);
    console.log(`   Converted to ${blocks.length} Notion blocks`);

    // Notion limits: 100 blocks per request, page-create children also capped at 100
    // We create the page first with first 100 blocks, then append rest in chunks
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
        properties: {
          title: { title: [{ text: { content: `📺 YouTube Digest ${dateStr}` } }] }
        },
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
      const appendRes = await fetch(`https://api.notion.com/v1/blocks/${newPageId}/children`, {
        method: 'PATCH',
        headers: notionHeaders(notionToken),
        body: JSON.stringify({ children: batch })
      });
      if (!appendRes.ok) {
        console.error(`   ⚠️  Failed to append batch: ${appendRes.status}`);
      }
    }

    notionUrl = createdPage.url;
    console.log(`   ✅ Notion: ${notionUrl}`);
  } catch (err) {
    console.error(`   ❌ Notion failed: ${err.message}`);
    notionUrl = `FAILED: ${err.message.slice(0, 100)}`;
  }
}

// Cleanup tmp files
const tmpDir = path.join(ROOT, 'tmp');
if (fs.existsSync(tmpDir)) {
  fs.readdirSync(tmpDir)
    .filter(f => f.includes(dateStr))
    .forEach(f => fs.unlinkSync(path.join(tmpDir, f)));
  console.log('🧹 Cleaned tmp files');
}

console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Digest complete!
📄 File:    output/${dateStr}.md
📊 Stats:   채널 ${channelCount}개 | 영상 ${videoCount}개 | 오류 ${report.errors || 0}건
📝 Notion:  ${notionUrl}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

// ── helpers ──────────────────────────────────────────────────

function notionHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Notion-Version': '2022-06-28'
  };
}

function getYesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

function formatDateKo(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${y}년 ${parseInt(m)}월 ${parseInt(d)}일`;
}

/**
 * Convert markdown to Notion blocks (subset: headings, paragraphs, bullets, quotes, dividers, tables-as-paragraphs)
 */
function markdownToNotionBlocks(md) {
  const blocks = [];
  const lines = md.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) { i++; continue; }

    // Divider
    if (trimmed === '---') {
      blocks.push({ object: 'block', type: 'divider', divider: {} });
      i++; continue;
    }

    // Headings
    if (trimmed.startsWith('# ')) {
      blocks.push(headingBlock(1, trimmed.slice(2)));
      i++; continue;
    }
    if (trimmed.startsWith('## ')) {
      blocks.push(headingBlock(2, trimmed.slice(3)));
      i++; continue;
    }
    if (trimmed.startsWith('### ')) {
      blocks.push(headingBlock(3, trimmed.slice(4)));
      i++; continue;
    }

    // Quote
    if (trimmed.startsWith('> ')) {
      blocks.push({
        object: 'block',
        type: 'quote',
        quote: { rich_text: parseRichText(trimmed.slice(2)) }
      });
      i++; continue;
    }

    // Bullet list
    if (trimmed.startsWith('- ')) {
      blocks.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: parseRichText(trimmed.slice(2)) }
      });
      i++; continue;
    }

    // Table — flatten to a code-block-style paragraph for simplicity
    if (trimmed.startsWith('|')) {
      const tableLines = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        tableLines.push(lines[i].trim());
        i++;
      }
      // Skip the separator row (|---|---|)
      const cleaned = tableLines.filter(l => !/^\|[\s\-:|]+\|$/.test(l));
      const tableText = cleaned.join('\n');
      blocks.push({
        object: 'block',
        type: 'code',
        code: {
          rich_text: [{ type: 'text', text: { content: tableText.slice(0, 2000) } }],
          language: 'plain text'
        }
      });
      continue;
    }

    // Default: paragraph
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: parseRichText(trimmed) }
    });
    i++;
  }

  return blocks;
}

function headingBlock(level, text) {
  const type = `heading_${level}`;
  return {
    object: 'block',
    type,
    [type]: { rich_text: parseRichText(text) }
  };
}

/**
 * Parse a line of markdown into Notion rich_text array.
 * Handles **bold** and plain text. Truncates each segment to 2000 chars.
 */
function parseRichText(text) {
  const parts = [];
  const regex = /\*\*([^*]+)\*\*/g;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(plainSegment(text.slice(lastIndex, match.index)));
    }
    parts.push(boldSegment(match[1]));
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push(plainSegment(text.slice(lastIndex)));
  }
  return parts.length > 0 ? parts : [plainSegment(text)];
}

function plainSegment(text) {
  return { type: 'text', text: { content: text.slice(0, 2000) } };
}

function boldSegment(text) {
  return {
    type: 'text',
    text: { content: text.slice(0, 2000) },
    annotations: { bold: true }
  };
}
