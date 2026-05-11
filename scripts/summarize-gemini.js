#!/usr/bin/env node
/**
 * summarize-gemini.js — Generate tmp/summaries-*.md from the latest tmp/raw-*.json
 * using the Gemini API.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const tmpDir = path.join(ROOT, 'tmp');

const apiKey = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_MODEL || 'gemini-3-fast';

if (!apiKey) {
  console.error('❌ GEMINI_API_KEY is required for Gemini summarization.');
  process.exit(1);
}

const rawFile = findLatestRaw(tmpDir);
if (!rawFile) {
  console.error(`❌ No raw-*.json found in ${tmpDir}`);
  process.exit(1);
}

const key = path.basename(rawFile).replace(/^raw-/, '').replace(/\.json$/, '');
const summariesFile = path.join(tmpDir, `summaries-${key}.md`);
const rawItems = JSON.parse(fs.readFileSync(rawFile, 'utf8'));
const formatGuide = fs.readFileSync(path.join(ROOT, 'config', 'format.md'), 'utf8');
const summarizerGuide = fs.readFileSync(path.join(ROOT, 'agents', 'summarizer.md'), 'utf8');

console.log(`🧠 Summarizing ${rawItems.length} video(s) with ${model}`);
console.log(`   Raw: ${path.relative(ROOT, rawFile)}`);

const prompt = buildPrompt({ key, rawItems, formatGuide, summarizerGuide });
const markdown = await generateWithGemini({ apiKey, model, prompt });
const cleaned = cleanMarkdown(markdown);

fs.writeFileSync(summariesFile, cleaned.endsWith('\n') ? cleaned : `${cleaned}\n`);
console.log(`✅ Wrote: ${path.relative(ROOT, summariesFile)}`);

function findLatestRaw(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter(file => file.startsWith('raw-') && file.endsWith('.json'))
    .map(file => ({ name: file, mtime: fs.statSync(path.join(dir, file)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length > 0 ? path.join(dir, files[0].name) : null;
}

function buildPrompt({ key, rawItems, formatGuide, summarizerGuide }) {
  const compactItems = rawItems.map(item => ({
    channel: item.channel,
    channelName: item.channelName,
    videoId: item.videoId,
    title: item.title,
    duration: item.duration,
    hasTranscript: item.hasTranscript,
    transcript: item.transcript,
    transcriptSegments: item.transcriptSegments || [],
    description: item.description || ''
  }));

  return `You are generating a Korean YouTube digest markdown file.

Return ONLY the final markdown. Do not wrap it in a code fence. Do not explain your work.

Digest key: ${key}
First line must be exactly: # YouTube Digest — ${key}

SOURCE OF TRUTH: config/format.md
${formatGuide}

SOURCE OF TRUTH: agents/summarizer.md
${summarizerGuide}

Additional non-negotiable requirements:
- Generate 한 줄 인사이트 and 핵심 요약 for every video.
- Do NOT generate a separate **주요 타임라인** section.
- Do NOT force a fixed number of 핵심 요약 points. Use as many numbered points and bullets as needed to capture the full video context.
- For videos with transcriptSegments, inline timestamps must cover the meaningful beginning, middle, and late parts of the video when those parts contain substantive content.
- For long videos, do not stop at timestamps from only the first few minutes.
- Each inline timestamp must use the same video ID and a correct t=SECONDS link.
- If transcriptSegments are missing, say [자막 기반 타임라인 없음] once in 핵심 요약 and summarize from transcript/description without inventing timestamps.
- Preserve channel grouping with channel headings formatted as ### 📺 [ChannelName](https://www.youtube.com/@handle).
- Separate videos with ---.

Raw video data JSON:
${JSON.stringify(compactItems, null, 2)}
`;
}

async function generateWithGemini({ apiKey, model, prompt }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.35,
        topP: 0.9,
        maxOutputTokens: 65536
      }
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini API failed (${response.status}): ${text.slice(0, 1000)}`);
  }

  const data = await response.json();
  const text = (data.candidates || [])
    .flatMap(candidate => candidate.content?.parts || [])
    .map(part => part.text || '')
    .join('')
    .trim();

  if (!text) {
    throw new Error('Gemini API returned no text.');
  }

  return text;
}

function cleanMarkdown(markdown) {
  return markdown
    .replace(/^```(?:markdown|md)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}
