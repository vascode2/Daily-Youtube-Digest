#!/usr/bin/env node
/**
 * summarize-claude.js — Ask Claude Code CLI to generate tmp/summaries-*.md
 * from the latest tmp/raw-*.json.
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const tmpDir = path.join(ROOT, 'tmp');

const model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const rawFile = findLatestRaw(tmpDir);

if (!rawFile) {
  console.error(`❌ No raw-*.json found in ${tmpDir}`);
  process.exit(1);
}

const key = path.basename(rawFile).replace(/^raw-/, '').replace(/\.json$/, '');
const summariesFile = path.join(tmpDir, `summaries-${key}.md`);

console.log(`🧠 Summarizing ${path.relative(ROOT, rawFile)} with ${model}`);

const prompt = `CI MODE — ONLY DO STEP 2 OF THE PIPELINE. Do NOT run npm commands. Do NOT write to output/. Do NOT trigger review or publish.

Your single job:
1. Read ${path.relative(ROOT, rawFile)}.
2. Read config/format.md and agents/summarizer.md — these are the SOURCE OF TRUTH for output format. Follow them exactly.
3. Write the final markdown summary to ${path.relative(ROOT, summariesFile)}.

Hard requirements, in addition to config/format.md and agents/summarizer.md:
- First line: '# YouTube Digest — ${key}'
- Channel header MUST be a hyperlink: '### 📺 [ChannelName](https://www.youtube.com/@handle)' using channelName for display text and the raw channel handle for the URL.
- Each video title MUST be h2 with clickable YouTube link: '## [Title](https://www.youtube.com/watch?v=VIDEO_ID)'.
- Section order per video: '한 줄 인사이트' → '핵심 요약'.
- Generate 한 줄 인사이트 and 핵심 요약 for every video.
- Do NOT generate a separate **주요 타임라인** section.
- Do NOT force a fixed number of 핵심 요약 points. Use as many numbered points and bullets as needed to capture the full video context.
- For videos with transcriptSegments, inline timestamps must cover the meaningful beginning, middle, and late parts of the video when those parts contain substantive content.
- For long videos, do not stop at timestamps from only the first few minutes.
- Each inline timestamp must use the same video ID and a correct t=SECONDS link.
- If transcriptSegments are missing, say [자막 기반 타임라인 없음] once in 핵심 요약 and summarize from transcript/description without inventing timestamps.
- DO NOT include upload dates, view counts, duration, or transcript indicators.
- Separator '---' between videos.

STOP immediately after writing ${path.relative(ROOT, summariesFile)}. Do not modify output/ or any other location.`;

const result = spawnSync('claude', [
  '--print',
  '--dangerously-skip-permissions',
  '--model',
  model,
  prompt
], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
  stdio: ['ignore', 'inherit', 'inherit']
});

if (result.error) {
  console.error(`❌ Failed to run Claude Code CLI: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  console.error(`❌ Claude Code CLI exited with status ${result.status}`);
  process.exit(result.status || 1);
}

if (!fs.existsSync(summariesFile)) {
  console.error(`❌ Expected summary file was not created: ${summariesFile}`);
  process.exit(1);
}

console.log(`✅ Wrote: ${path.relative(ROOT, summariesFile)}`);

function findLatestRaw(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter(file => file.startsWith('raw-') && file.endsWith('.json'))
    .map(file => ({ name: file, mtime: fs.statSync(path.join(dir, file)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length > 0 ? path.join(dir, files[0].name) : null;
}
