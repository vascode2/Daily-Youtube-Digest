# Sub-Agent: Publisher

## Role
Format final summaries and deliver to output destinations.

## Output Destinations
1. **Local file** (always): `output/YYYY-MM-DD.md`
2. **Notion** (if NOTION_TOKEN and NOTION_PAGE_ID env vars are set): one plain child page per digest, newest on top

## Local File Format
```markdown
# YouTube Digest — YYYY년 MM월 DD일

> 생성 시각: HH:MM | 처리 채널: N개 | 영상: N개

---

## @ChannelHandle

### 영상 제목
...summary content from format.md...

---
```

## Notion Structure (plain child pages, newest-on-top)
Each digest is a **plain child page** directly under NOTION_PAGE_ID. New pages are
inserted at the **top** of the parent so the newest digest is always first — the
same structure used by the sibling Daily-News-Digest project.

How newest-on-top works: `pages.create` accepts a `position` object
(Notion-Version `2026-03-11`). Passing `position: { type: 'page_start' }` inserts
the new child page at the **top** of the parent (older `pages.create` calls without
`position` append at the bottom). `createDigestPage()` sends this on every publish,
with a graceful fallback that retries without `position` if the API ever rejects it.

- Page title:
  - Daily:   `📺 YYYY-MM-DD`
  - Weekly:  `📺 Weekly Digest YYYY-MM-DD ~ YYYY-MM-DD`
  - Channel: `📺 Channel Digest: @handle (YYYY-MM-DD)`
- De-duplication: before inserting, existing `child_page` blocks with the **same
  title** are archived (soft-deleted), so re-running publish on the same digest
  never duplicates.
- API version: `2026-03-11` (required for the `position` param).
- Implemented directly in `scripts/publish.js`
  (`listChildBlocks` → dedup → `createDigestPage` with `position: page_start`).

### One-time migration
`scripts/migrate-db-to-pages.js` performed a one-time conversion from the previous
inline database (`📺 YouTube Digests`) back into flat, newest-on-top child pages,
then deleted the database. It is not part of the recurring pipeline.

## Rules
- Always write local file first; Notion is optional
- If Notion API fails: log error, do not retry, local file is sufficient
- After successful publish: delete tmp/ files to save disk space
- Print final report to stdout:
  ```
  ✅ Digest complete: output/YYYY-MM-DD.md
  📊 Channels: 3 | Videos: 7 | Errors: 0
  📝 Notion: https://notion.so/... (or SKIPPED)
  ```
