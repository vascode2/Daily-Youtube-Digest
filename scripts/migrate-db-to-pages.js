#!/usr/bin/env node
/**
 * migrate-db-to-pages.js — ONE-TIME migration.
 *
 * Converts the old inline "📺 YouTube Digests" database (rows) plus any loose
 * child-page digests back into a single flat list of plain child pages under
 * NOTION_PAGE_ID, sorted newest-on-top, then deletes the database.
 *
 * Why the temp round-trip: the Notion API cannot reorder child pages in place
 * (move-to-same-parent returns 400) and `move` ignores the position param
 * (always appends at the bottom). So we move every digest page into a temporary
 * container, then move them back into the parent in DESCENDING date order — each
 * append lands at the bottom, so the newest (moved first) ends up on top.
 *
 * Safe to re-run: if there is no database and pages are already flat, it exits.
 * Supports --dry-run.
 *
 * Requires Notion-Version 2026-03-11 (databases, data sources, page move).
 */

const token = process.env.NOTION_TOKEN;
const parentPageId = process.env.NOTION_PAGE_ID;
const dryRun = process.argv.includes('--dry-run');
const API = 'https://api.notion.com/v1';
const VERSION = process.env.NOTION_VERSION || '2026-03-11';
const DIGEST_DB_TITLE = '📺 YouTube Digests';

if (!token || !parentPageId) {
  console.error('❌ NOTION_TOKEN and NOTION_PAGE_ID must be set');
  process.exit(1);
}

const H = {
  'Authorization': `Bearer ${token}`,
  'Content-Type': 'application/json',
  'Notion-Version': VERSION
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function nf(url, options = {}, { tries = 5 } = {}) {
  let last;
  for (let attempt = 0; attempt < tries; attempt++) {
    const res = await fetch(url, { headers: H, ...options });
    if (res.status === 429 || res.status >= 500) {
      last = res;
      const ra = parseFloat(res.headers.get('retry-after') || '0');
      await sleep(ra > 0 ? ra * 1000 : 600 * (attempt + 1));
      continue;
    }
    return res;
  }
  return last;
}
async function jf(url, options) { const r = await nf(url, options); const t = await r.text(); let b; try { b = JSON.parse(t); } catch { b = t; } return { ok: r.ok, status: r.status, body: b, text: t }; }

// Extract YYYY-MM-DD (end date for ranges) from a digest title, for sorting.
function dateKey(title) {
  const t = String(title || '');
  const range = t.match(/(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})/);
  if (range) return range[2];
  const day = t.match(/(\d{4}-\d{2}-\d{2})/);
  return day ? day[1] : null;
}

async function listChildren(blockId) {
  const out = [];
  let cursor;
  do {
    const url = new URL(`${API}/blocks/${blockId}/children`);
    url.searchParams.set('page_size', '100');
    if (cursor) url.searchParams.set('start_cursor', cursor);
    const { ok, body, status } = await jf(url.toString(), { method: 'GET' });
    if (!ok) throw new Error(`list children ${status}`);
    out.push(...(body.results || []));
    cursor = body.has_more ? body.next_cursor : null;
  } while (cursor);
  return out;
}

async function queryAllRows(dataSourceId) {
  const out = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const { ok, body: b, status } = await jf(`${API}/data_sources/${dataSourceId}/query`, {
      method: 'POST', body: JSON.stringify(body)
    });
    if (!ok) throw new Error(`query rows ${status}`);
    out.push(...(b.results || []));
    cursor = b.has_more ? b.next_cursor : null;
  } while (cursor);
  return out;
}
const rowTitle = p => p.properties?.Name?.title?.map(t => t.plain_text).join('') || '';

async function moveTo(pageId, parent) {
  const { ok, status, text } = await jf(`${API}/pages/${pageId}/move`, {
    method: 'POST', body: JSON.stringify({ parent })
  });
  if (!ok) throw new Error(`move ${status}: ${text.slice(0, 150)}`);
}
async function archive(pageOrBlockId, kind = 'blocks') {
  const { ok, status } = await jf(`${API}/${kind}/${pageOrBlockId}`, { method: 'DELETE' });
  if (!ok && kind === 'blocks') {
    // fall back to page trash
    await jf(`${API}/pages/${pageOrBlockId}`, { method: 'PATCH', body: JSON.stringify({ in_trash: true }) });
  }
}

(async () => {
  console.log(`🔧 DB→pages migration${dryRun ? ' (dry-run)' : ''}\n`);

  const children = await listChildren(parentPageId);
  const dbBlocks = children.filter(b => b.type === 'child_database'
    && (b.child_database?.title || '').trim() === DIGEST_DB_TITLE);
  const loose = children.filter(b => b.type === 'child_page' && dateKey(childPageTitle(b)));
  function childPageTitle(b) { return b.child_page?.title || ''; }

  // Gather digest pages from both sources: { id, title, date, from }
  const items = [];
  for (const b of loose) items.push({ id: b.id, title: b.child_page.title, date: dateKey(b.child_page.title), from: 'loose' });

  let dataSourceId = null;
  for (const db of dbBlocks) {
    const { body } = await jf(`${API}/databases/${db.id}`, { method: 'GET' });
    dataSourceId = body.data_sources?.[0]?.id || body.initial_data_source?.id || null;
    if (!dataSourceId) continue;
    const rows = await queryAllRows(dataSourceId);
    for (const r of rows) {
      const title = rowTitle(r);
      items.push({ id: r.id, title, date: dateKey(title), from: 'db' });
    }
  }

  console.log(`Found ${loose.length} loose page(s), ${dbBlocks.length} database block(s), ${items.length} digest page(s) total.`);

  if (items.length === 0) {
    console.log('Nothing to migrate.');
    return;
  }

  // Dedup by title (exact). Keep the first occurrence, archive the rest.
  const seen = new Map();
  const keep = [];
  const dupes = [];
  for (const it of items) {
    if (!it.date) continue;
    if (seen.has(it.title)) { dupes.push(it); continue; }
    seen.set(it.title, it);
    keep.push(it);
  }
  // Sort DESCENDING by date (newest first) so move-back puts newest on top.
  keep.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  console.log(`Keeping ${keep.length} unique page(s); ${dupes.length} duplicate(s) to archive.`);
  console.log(`Newest: ${keep[0]?.title}  |  Oldest: ${keep[keep.length - 1]?.title}`);

  if (dryRun) {
    console.log('\n(dry-run) Order after migration (top→bottom):');
    keep.forEach((it, i) => { if (i < 5 || i > keep.length - 3) console.log(`  ${i + 1}. ${it.title} [${it.from}]`); else if (i === 5) console.log('  ...'); });
    return;
  }

  // 1. Archive duplicates.
  for (const d of dupes) {
    await archive(d.id, d.from === 'loose' ? 'blocks' : 'pages');
    console.log(`  🗑️  archived duplicate: ${d.title}`);
  }

  // 2. Create a temp container page.
  const { body: temp } = await jf(`${API}/pages`, {
    method: 'POST',
    body: JSON.stringify({
      parent: { type: 'page_id', page_id: parentPageId },
      properties: { title: { title: [{ text: { content: '⏳ migration temp' } }] } }
    })
  });
  const tempId = temp.id;
  console.log(`  📦 temp container: ${tempId}`);

  // 3. Move loose pages into temp (they can't be reordered inside their current
  //    parent, so they must leave first).
  for (const it of keep.filter(x => x.from === 'loose')) {
    await moveTo(it.id, { type: 'page_id', page_id: tempId });
    it.from = 'temp';
  }
  console.log(`  ➡️  moved ${keep.filter(x => x.from === 'temp').length} loose page(s) into temp`);

  // 4. Move every page back into the parent in DESCENDING date order. Each move
  //    appends at the bottom, so the newest (first moved) ends up on top.
  let n = 0;
  for (const it of keep) {
    await moveTo(it.id, { type: 'page_id', page_id: parentPageId });
    n++;
    if (n % 10 === 0 || n === keep.length) console.log(`  ✅ ${n}/${keep.length} moved`);
  }

  // 5. Archive the now-empty database block(s) and the temp container.
  for (const db of dbBlocks) { await archive(db.id, 'blocks'); console.log(`  🧹 removed database block`); }
  await archive(tempId, 'blocks');
  console.log('  🧹 removed temp container');

  console.log('\n✅ Migration complete — digests are now plain child pages, newest on top.');
})().catch(err => { console.error('❌', err.message); process.exit(1); });
