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

// Build final output with header
const now = new Date();
const timeStr = now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : {};
const summaries = fs.readFileSync(summariesFile, 'utf8');

// Count stats from summaries
const channelCount = (summaries.match(/^## @/gm) || []).length;
const videoCount = (summaries.match(/^### /gm) || []).length;

const header = `# 📺 YouTube Digest — ${formatDateKo(dateStr)}

> 생성: ${timeStr} | 채널: ${channelCount}개 | 영상: ${videoCount}개${report.errors > 0 ? ` | ⚠️ 리뷰 오류: ${report.errors}건` : ''}

---
`;

const finalContent = header + summaries.replace(/^# YouTube Digest.*\n\n/, '');
fs.writeFileSync(outputFile, finalContent);
console.log(`✅ Saved: ${outputFile}`);

// Optional: Notion publish
const notionToken = process.env.NOTION_TOKEN;
const notionPageId = process.env.NOTION_PAGE_ID;

let notionUrl = 'SKIPPED';

if (notionToken && notionPageId) {
  console.log('📝 Publishing to Notion...');
  try {
    const response = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${notionToken}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify({
        parent: { page_id: notionPageId },
        properties: {
          title: {
            title: [{ text: { content: `📺 YouTube Digest ${dateStr}` } }]
          }
        },
        children: [
          {
            object: 'block',
            type: 'paragraph',
            paragraph: {
              rich_text: [{ type: 'text', text: { content: finalContent.slice(0, 2000) } }]
            }
          }
        ]
      })
    });

    if (response.ok) {
      const data = await response.json();
      notionUrl = `https://notion.so/${data.id.replace(/-/g, '')}`;
      console.log(`  ✅ Notion: ${notionUrl}`);
    } else {
      console.error(`  ❌ Notion API error: ${response.status}`);
    }
  } catch (err) {
    console.error(`  ❌ Notion failed: ${err.message}`);
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

// Final report
console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Digest complete!
📄 File:    output/${dateStr}.md
📊 Stats:   채널 ${channelCount}개 | 영상 ${videoCount}개 | 오류 ${report.errors || 0}건
📝 Notion:  ${notionUrl}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

function getYesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

function formatDateKo(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${y}년 ${parseInt(m)}월 ${parseInt(d)}일`;
}
