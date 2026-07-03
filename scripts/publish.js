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
const isChannel = key.startsWith('channel-');
let startStr, endStr, channelHandle;
if (isChannel) {
  // key format: channel-{handle}-YYYY-MM-DD
  const m = key.match(/^channel-(.+)-(\d{4}-\d{2}-\d{2})$/);
  if (m) { channelHandle = m[1]; endStr = startStr = m[2]; }
  else { endStr = startStr = key; }
} else {
  [startStr, endStr] = isRange ? key.split('_to_') : [key, key];
}

fs.mkdirSync(outputDir, { recursive: true });

// Display timestamp in DIGEST_TIMEZONE (set in workflow), or local TZ if unset
const now = new Date();
const displayTz = process.env.DIGEST_TIMEZONE || undefined;
const timeStr = formatGeneratedTime(now, displayTz);
const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : {};
const summaries = fs.readFileSync(summariesFile, 'utf8');

// New format: channels are h3 with `### 📺 @handle`, videos are h2 with `## [Title](url)`
const channelCount = (summaries.match(/^###\s+📺\s+/gm) || []).length;
const videoCount = (summaries.match(/^##\s+\[/gm) || []).length;

const titleHeading = isChannel
  ? `# 📺 Channel Digest — @${channelHandle} (${formatDateKo(endStr)})`
  : isRange
    ? `# 📺 YouTube Weekly Digest — ${formatDateKo(startStr)} ~ ${formatDateKo(endStr)}`
    : `# 📺 YouTube Digest — ${formatDateKo(endStr)}`;

const header = `${titleHeading}

> 생성: ${timeStr} | 채널: ${channelCount}개 | 영상: ${videoCount}개${report.errors > 0 ? ` | ⚠️ 리뷰 오류: ${report.errors}건` : ''}

---
`;

// Strip any pre-existing top-level title, ALL leading quote/stats lines (publish
// can be re-run on the same output file, so multiple '> 생성: ...' lines may have
// accumulated), and any opening divider.
let stripped = summaries.replace(/^#\s+[^\n]*\n+/, '');
// Remove leading quote-block / divider lines repeatedly until none remain.
while (/^>\s+[^\n]*\n+/.test(stripped) || /^---\s*\n+/.test(stripped) || /^\s*\n/.test(stripped)) {
  stripped = stripped
    .replace(/^>\s+[^\n]*\n+/, '')
    .replace(/^---\s*\n+/, '')
    .replace(/^\s*\n/, '');
}
const finalContent = header + stripped;
fs.writeFileSync(outputFile, finalContent);
console.log(`✅ Saved: ${outputFile}`);

const notionToken = process.env.NOTION_TOKEN;
const notionPageId = process.env.NOTION_PAGE_ID;
const notionRootTitle = process.env.NOTION_ROOT_TITLE || 'Youtbue Digest';

let notionUrl = 'SKIPPED (no NOTION_TOKEN/NOTION_PAGE_ID set)';

if (notionToken && notionPageId) {
  console.log('📝 Publishing to Notion...');
  try {
    await tryUpdateParentPageTitle(notionPageId, notionRootTitle, notionToken);

    const blocks = markdownToNotionBlocks(finalContent);
    console.log(`   Converted to ${blocks.length} Notion blocks`);

    const notionTitle = isChannel
      ? `📺 Channel Digest: @${channelHandle} (${endStr})`
      : isRange
        ? `📺 Weekly Digest ${startStr} ~ ${endStr}`
        : `📺 ${endStr}`;

    // De-dup: archive any existing child page(s) with the same title so re-runs
    // don't pile up duplicate date pages.
    try {
      const children = await listChildBlocks(notionPageId, notionToken);
      const dupes = children.filter(b => b.type === 'child_page' && childPageTitle(b) === notionTitle);
      for (const dup of dupes) {
        await archiveBlock(dup.id, notionToken);
        console.log(`   🗑️  Archived existing page "${notionTitle}"`);
      }
    } catch (err) {
      console.log(`   ⚠️  Dedup skipped: ${err.message}`);
    }

    // Insert as a plain child page at the TOP of the parent so the newest digest
    // appears first (position:page_start requires Notion-Version 2026-03-11).
    const createdPage = await createDigestPage({
      parentPageId: notionPageId,
      title: notionTitle,
      blocks,
      position: { type: 'page_start' },
      token: notionToken
    });

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
    // 2026-03-11 introduced the `position` object (insert at page_start/end/
    // after_block), which we use to keep the newest digest page on top.
    'Notion-Version': process.env.NOTION_VERSION || '2026-03-11'
  };
}

// List all direct child blocks of a page/block (paginated).
async function listChildBlocks(blockId, token) {
  const out = [];
  let cursor;
  do {
    const url = new URL(`https://api.notion.com/v1/blocks/${blockId}/children`);
    url.searchParams.set('page_size', '100');
    if (cursor) url.searchParams.set('start_cursor', cursor);
    const res = await fetch(url.toString(), { method: 'GET', headers: notionHeaders(token) });
    if (!res.ok) throw new Error(`List children failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    out.push(...(json.results || []));
    cursor = json.has_more ? json.next_cursor : null;
  } while (cursor);
  return out;
}

// Plain-text title of a child_page block.
function childPageTitle(block) {
  if (block?.type !== 'child_page') return null;
  return block.child_page?.title || '';
}

// Archive (soft-delete) a block by id.
async function archiveBlock(blockId, token) {
  const res = await fetch(`https://api.notion.com/v1/blocks/${blockId}`, {
    method: 'DELETE',
    headers: notionHeaders(token)
  });
  if (!res.ok) throw new Error(`Archive failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
}

// Create a digest page under a parent page from already-converted blocks.
// `position` is an optional Notion position object, e.g. { type: 'page_start' }.
// Falls back gracefully (no position) if the API rejects the position param.
async function createDigestPage({ parentPageId, title, blocks, position, token }) {
  const firstBatch = blocks.slice(0, 100);
  const restBatches = [];
  for (let i = 100; i < blocks.length; i += 100) restBatches.push(blocks.slice(i, i + 100));

  const body = {
    parent: { page_id: parentPageId },
    properties: { title: { title: [{ text: { content: title } }] } },
    children: firstBatch
  };
  if (position) body.position = position;

  let res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST', headers: notionHeaders(token), body: JSON.stringify(body)
  });

  // If the position parameter is unsupported, retry once without it.
  if (!res.ok && position) {
    const errText = await res.text();
    if (res.status === 400 && /position/i.test(errText)) {
      console.log(`   ⚠️  position param rejected (${errText.slice(0, 150)}); creating without ordering.`);
      delete body.position;
      res = await fetch('https://api.notion.com/v1/pages', {
        method: 'POST', headers: notionHeaders(token), body: JSON.stringify(body)
      });
    } else {
      throw new Error(`${res.status}: ${errText}`);
    }
  }
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);

  const page = await res.json();
  for (const batch of restBatches) {
    const r = await fetch(`https://api.notion.com/v1/blocks/${page.id}/children`, {
      method: 'PATCH', headers: notionHeaders(token), body: JSON.stringify({ children: batch })
    });
    if (!r.ok) console.error(`   ⚠️  Append failed: ${r.status}`);
  }
  return page;
}

function formatGeneratedTime(date, timeZone) {
  const time = date.toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone
  });
  if (!timeZone) return time;

  const tzName = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'short'
  })
    .formatToParts(date)
    .find(part => part.type === 'timeZoneName')?.value;

  return tzName ? `${time} ${tzName}` : time;
}

async function tryUpdateParentPageTitle(pageId, targetTitle, token) {
  try {
    const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH',
      headers: notionHeaders(token),
      body: JSON.stringify({
        properties: {
          title: {
            title: [{ text: { content: targetTitle } }]
          }
        }
      })
    });

    if (!res.ok) {
      console.log(`   ⚠️  Could not rename parent page title (${res.status})`);
    }
  } catch (err) {
    console.log(`   ⚠️  Could not rename parent page title (${err.message})`);
  }
}

function formatDateKo(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${y}.${m}.${d}`;
}

function markdownToNotionBlocks(md) {
  const blocks = [];
  const lines = md.split('\n');
  let i = 0;

  // Returns [block, linesConsumed] for a list item starting at `lines[idx]`,
  // recursively attaching any deeper-indented bullets/items as children.
  function parseListItem(idx, parentIndent) {
    const raw = lines[idx];
    const indent = raw.match(/^\s*/)[0].length;
    const stripped = raw.slice(indent);
    let type, content;
    const numMatch = stripped.match(/^(\d+)\.\s+(.*)$/);
    if (numMatch) { type = 'numbered_list_item'; content = numMatch[2]; }
    else { type = 'bulleted_list_item'; content = stripped.replace(/^[*-]\s+/, ''); }

    const children = [];
    let j = idx + 1;
    while (j < lines.length) {
      const next = lines[j];
      if (!next.trim()) { j++; continue; }
      const nextIndent = next.match(/^\s*/)[0].length;
      if (nextIndent <= indent) break;
      if (/^\s*(?:[*-]|\d+\.)\s+/.test(next)) {
        const [child, consumed] = parseListItem(j, indent);
        children.push(child);
        j += consumed;
      } else {
        // Treat indented prose as a paragraph child
        children.push({
          object: 'block', type: 'paragraph',
          paragraph: { rich_text: parseRichText(next.trim()) }
        });
        j++;
      }
    }
    const block = {
      object: 'block', type,
      [type]: { rich_text: parseRichText(content) }
    };
    if (children.length) block[type].children = children;
    return [block, j - idx];
  }

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
    // Top-level list item: bulleted (`- ` / `* `) or numbered (`N. `).
    if (/^\s*(?:[*-]|\d+\.)\s+/.test(line) && line.match(/^\s*/)[0].length === 0) {
      const [block, consumed] = parseListItem(i, -1);
      blocks.push(block);
      i += consumed;
      continue;
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
  // Channel headers (### 📺 Channel Name) are styled red for visibility
  const isChannelHeader = level === 3 && /^📺\s/.test(text);
  const block = { rich_text: parseRichText(text) };
  if (isChannelHeader) block.color = 'red';
  return { object: 'block', type, [type]: block };
}

/**
 * Parse markdown inline syntax into Notion rich_text array.
 * Supports: [text](url) links, **bold**, plain text. Order-independent.
 */
function parseRichText(text) {
  // Tokenize: find all [text](url) and **bold** spans, fill the rest as plain.
  // Link regex: non-greedy text, but must be followed by '](http...' so nested
  // brackets in YouTube titles like '[프롬프트 공유] 시댄스...' are handled.
  const tokens = [];
  const linkRe = /\[([\s\S]+?)\]\((https?:\/\/[^)]+)\)/g;
  const boldRe = /\*\*([^*]+)\*\*/g;
  const matches = [];
  let m;
  while ((m = linkRe.exec(text)) !== null) {
    matches.push({ start: m.index, end: m.index + m[0].length, kind: 'link', text: m[1], url: m[2] });
  }
  while ((m = boldRe.exec(text)) !== null) {
    matches.push({ start: m.index, end: m.index + m[0].length, kind: 'bold', text: m[1] });
  }
  matches.sort((a, b) => a.start - b.start);

  // Drop overlapping matches (keep first)
  const filtered = [];
  let lastEnd = 0;
  for (const mt of matches) {
    if (mt.start >= lastEnd) { filtered.push(mt); lastEnd = mt.end; }
  }

  let cursor = 0;
  for (const mt of filtered) {
    if (mt.start > cursor) tokens.push(plainSegment(text.slice(cursor, mt.start)));
    if (mt.kind === 'link') tokens.push(linkSegment(mt.text, mt.url));
    else if (mt.kind === 'bold') tokens.push(boldSegment(mt.text));
    cursor = mt.end;
  }
  if (cursor < text.length) tokens.push(plainSegment(text.slice(cursor)));

  return tokens.length > 0 ? tokens : [plainSegment(text)];
}

function plainSegment(t) {
  return { type: 'text', text: { content: t.slice(0, 2000) } };
}
function boldSegment(t)  {
  return { type: 'text', text: { content: t.slice(0, 2000) }, annotations: { bold: true } };
}
function linkSegment(t, url) {
  return { type: 'text', text: { content: t.slice(0, 2000), link: { url } } };
}
