#!/usr/bin/env node
/**
 * summarize-gemini.js — Generate tmp/summaries-*.md from the latest tmp/raw-*.json
 * using the fastest available Gemini text model that supports generateContent.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const tmpDir = path.join(ROOT, 'tmp');

const apiKey = process.env.GEMINI_API_KEY;
const preferredModel = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const fallbackModels = (process.env.GEMINI_MODEL_FALLBACKS || [
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3-fast',
  'gemini-3-flash',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-flash-latest',
  'gemini-flash-lite-latest'
].join(','))
  .split(',')
  .map(model => model.trim())
  .filter(Boolean);

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

// Optional sibling file from collect.js — videos dropped because the per-channel
// cap was reached. Rendered as a small "다른 영상" list under each channel
// section so the user can still see what they missed without paying for a summary.
const skippedFile = path.join(tmpDir, `skipped-${key}.json`);
const skippedByChannel = fs.existsSync(skippedFile)
  ? JSON.parse(fs.readFileSync(skippedFile, 'utf8'))
  : {};

// Pause between videos to stay under Gemini's free-tier 10 RPM ceiling.
// 7s → ~8.5 RPM peak, leaves margin for the occasional retry.
const videoDelayMs = Math.max(0, parseInt(process.env.GEMINI_VIDEO_DELAY_MS || '7000', 10));

console.log(`🔎 Resolving Gemini text model, preferred: ${preferredModel}`);
const availableModels = await listGenerateContentModels(apiKey);
const modelCandidates = chooseModelCandidates({ preferredModel, fallbackModels, availableModels });

if (modelCandidates.length === 0) {
  console.error('❌ No Gemini text models that support generateContent are available for this API key.');
  console.error('   Check the API key, billing/quota, and Google AI Studio model access.');
  process.exit(1);
}

console.log(`🧠 Summarizing ${rawItems.length} video(s)`);
console.log(`   Raw: ${path.relative(ROOT, rawFile)}`);
console.log(`   Model candidates: ${modelCandidates.join(', ')}`);

const channelOrder = [];
const channelSections = new Map();
let selectedModel = null;
// Models that returned 429 in this run — don't waste a request retrying them.
// Each Gemini model has its own independent quota bucket, so falling through
// to the next candidate almost always succeeds.
const exhaustedModels = new Set();

for (let index = 0; index < rawItems.length; index++) {
  const item = rawItems[index];
  const handle = normalizeChannelHandle(item.channel);
  const channelKey = `${handle}\n${item.channelName || handle}`;
  if (!channelSections.has(channelKey)) {
    channelOrder.push(channelKey);
    channelSections.set(channelKey, {
      heading: `### 📺 [${item.channelName || handle}](https://www.youtube.com/${handle})`,
      videos: [],
      handle
    });
  }

  console.log(`\n▶️  Video ${index + 1}/${rawItems.length}: ${item.title}`);
  if (index > 0 && videoDelayMs > 0) {
    await delay(videoDelayMs);
  }
  const prompt = buildVideoPrompt(item);
  const baseCandidates = selectedModel
    ? [selectedModel, ...modelCandidates.filter(model => model !== selectedModel)]
    : modelCandidates;
  const liveCandidates = baseCandidates.filter(model => !exhaustedModels.has(model));
  if (liveCandidates.length === 0) {
    throw new Error(`All ${modelCandidates.length} Gemini text model(s) hit quota in this run. Wait for the free-tier window to reset, enable billing, or reduce collected videos.`);
  }
  const result = await generateVideoWithFallback({
    apiKey,
    modelCandidates: liveCandidates,
    prompt,
    videoTitle: item.title,
    onModelExhausted: model => exhaustedModels.add(model)
  });
  selectedModel = result.model;
  channelSections.get(channelKey).videos.push(cleanVideoBlock(result.markdown, item));
  fs.writeFileSync(summariesFile, renderDigest({ key, channelOrder, channelSections, skippedByChannel }));
  console.log(`   ✅ Done with ${result.model}`);
}

console.log(`\n✅ Wrote: ${path.relative(ROOT, summariesFile)} using ${selectedModel || 'unknown model'}`);

function findLatestRaw(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter(file => file.startsWith('raw-') && file.endsWith('.json'))
    .map(file => ({ name: file, mtime: fs.statSync(path.join(dir, file)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length > 0 ? path.join(dir, files[0].name) : null;
}

async function listGenerateContentModels(apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini ListModels failed (${response.status}): ${compactErrorText(text)}`);
  }

  const data = await response.json();
  return (data.models || [])
    .filter(model => (model.supportedGenerationMethods || []).includes('generateContent'))
    .map(model => normalizeModelName(model.name))
    .filter(isLikelyTextModel)
    .filter(Boolean);
}

function chooseModelCandidates({ preferredModel, fallbackModels, availableModels }) {
  const available = new Set(availableModels.map(normalizeModelName));
  const explicitCandidates = [preferredModel, ...fallbackModels]
    .map(normalizeModelName)
    .filter(unique)
    .filter(model => available.has(model));

  const discoveredFastModels = availableModels
    .map(normalizeModelName)
    .filter(model => /gemini/i.test(model) && /(fast|flash)/i.test(model))
    .filter(isLikelyTextModel)
    .sort(compareGeminiPreference);

  return [...explicitCandidates, ...discoveredFastModels].filter(unique);
}

async function generateVideoWithFallback({ apiKey, modelCandidates, prompt, videoTitle, onModelExhausted }) {
  const errors = [];

  for (const model of modelCandidates) {
    try {
      console.log(`   Trying model: ${model}`);
      const markdown = await generateWithGemini({ apiKey, model, prompt });
      return { markdown, model };
    } catch (err) {
      const info = classifyGeminiError(err);
      errors.push(`${model}: ${info.summary}`);
      console.warn(`   ⚠️  ${model} failed: ${info.summary}`);

      if (info.retryAfterMs > 0 && info.retryAfterMs <= 65000) {
        console.warn(`   ↻ Waiting ${Math.ceil(info.retryAfterMs / 1000)}s for Gemini quota retry hint, then retrying ${model} once`);
        await delay(info.retryAfterMs + 250);
        try {
          const markdown = await generateWithGemini({ apiKey, model, prompt });
          return { markdown, model };
        } catch (retryErr) {
          const retryInfo = classifyGeminiError(retryErr);
          errors.push(`${model} retry: ${retryInfo.summary}`);
          console.warn(`   ⚠️  ${model} retry failed: ${retryInfo.summary}`);
          if (retryInfo.isQuota) {
            // Mark this model as out for the rest of the run and try the next one.
            // Each Gemini model has its own quota bucket so the next candidate
            // (e.g. -lite, -2.0, -flash-latest) almost always still has budget.
            if (typeof onModelExhausted === 'function') onModelExhausted(model);
            console.warn(`   ⏭️  Marking ${model} as exhausted for this run; trying next candidate`);
            continue;
          }
        }
      }

      if (info.isQuota) {
        if (typeof onModelExhausted === 'function') onModelExhausted(model);
        console.warn(`   ⏭️  Marking ${model} as exhausted for this run; trying next candidate`);
        continue;
      }
    }
  }

  throw quotaError({ videoTitle, errors });
}

function buildVideoPrompt(item) {
  const video = {
    channel: item.channel,
    channelName: item.channelName,
    videoId: item.videoId,
    title: item.title,
    duration: item.duration,
    hasTranscript: item.hasTranscript,
    transcript: item.transcript,
    transcriptSegments: item.transcriptSegments || [],
    description: item.description || ''
  };

  return `Write ONE Korean YouTube digest video block in markdown. Return only this video block.

Required shape:
## [${item.title}](https://www.youtube.com/watch?v=${item.videoId})

**한 줄 인사이트**
💡 One distinct Korean sentence with the most important claim/number/judgment.

**핵심 요약**
A 2-3 sentence Korean intro paragraph that frames the video's arc (who is speaking, what they argue, and how they get there), then 3-5 numbered bold subheadings, each with 1-2 sub-bullets that carry the substance.

**주요 타임라인**
Exactly 3 timestamp bullets that represent early/middle/late meaningful parts.

Goal:
- Write so a reader who has NOT watched the video understands the speaker's argument and how they build it.
- The intro must capture the story flow, not just the topic. Avoid generic openers like "이 영상은 …을 다룬다".

Length:
- Intro paragraph: 2-3 Korean sentences.
- Numbered points: 3 to 5 (use 4-5 when the transcript clearly supports it; do not cap at 3).
- Each numbered point has 1 or 2 sub-bullets.
- Total sub-bullets across all numbered points: up to 8.
- Each sub-bullet is 1-2 sentences, roughly 60-120 Korean characters.

Content rules:
- Include concrete names, companies, numbers, years, product names from the transcript inside sub-bullets.
- Up to 2 example/demo/case/comparison references are allowed, only when they materially change the meaning.
- Do not echo the video title in the intro's first sentence — the title is already in the h2 above.
- Do not add FAE perspective, takeaway lines, or general advice that the video did not actually say.
- English source videos must still be summarized in Korean (translate proper nouns naturally; keep widely-known product names in English).
- Do not use blockquote '>' markers anywhere.

Timeline rules:
- For transcriptSegments, write exactly 3 주요 타임라인 links like [[12:34](https://www.youtube.com/watch?v=${item.videoId}&t=754)] across early/middle/late meaningful parts.
- For long videos, do not cite only the first few minutes.
- If transcriptSegments are missing, write [자막 기반 타임라인 없음] once under 주요 타임라인 and do not invent timestamps.
- Do not include views, upload date, duration, or transcript indicators anywhere.

Markdown shape (important):
- Each numbered head MUST be written as "1. **Title**" (the bold wraps only the title, NOT the number). Do NOT write "**1. Title**".
- Each sub-bullet MUST be indented with three spaces under its numbered head, e.g. "   - bullet text". Do NOT leave sub-bullets flush left.
- 주요 타임라인 bullets stay flush left (top-level list).

Raw video JSON:
${JSON.stringify(video, null, 2)}
`;
}

async function generateWithGemini({ apiKey, model, prompt }) {
  const modelId = normalizeModelName(model);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.35,
        topP: 0.9
      }
    })
  });

  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`Gemini API failed (${response.status}): ${compactErrorText(text)}`);
    error.status = response.status;
    error.body = text;
    throw error;
  }

  const data = await response.json();
  const text = (data.candidates || [])
    .flatMap(candidate => candidate.content?.parts || [])
    .map(part => part.text || '')
    .join('')
    .trim();

  if (!text) throw new Error('Gemini API returned no text.');
  return text;
}

function renderDigest({ key, channelOrder, channelSections, skippedByChannel = {} }) {
  const parts = [`# YouTube Digest — ${key}`, ''];
  for (const channelKey of channelOrder) {
    const section = channelSections.get(channelKey);
    parts.push(section.heading, '', section.videos.join('\n\n---\n\n'));
    const skipped = skippedByChannel[section.handle];
    if (skipped && Array.isArray(skipped.items) && skipped.items.length > 0) {
      // Separate block (own --- fence) so review.js's per-video parser ignores it.
      parts.push('', '---', '', '**다른 영상 (요약 안 함)**');
      for (const v of skipped.items) {
        parts.push(`- [${v.title}](https://www.youtube.com/watch?v=${v.videoId})`);
      }
    }
    parts.push('', '---', '');
  }
  return parts.join('\n').replace(/\n{4,}/g, '\n\n\n').trimEnd() + '\n';
}

function cleanVideoBlock(markdown, item) {
  let block = cleanMarkdown(markdown);
  block = block.replace(/^#\s+[^\n]+\n+/, '').trim();
  block = normalizeNumberedSections(block);
  if (!/^##\s+\[/.test(block)) {
    block = `## [${item.title}](https://www.youtube.com/watch?v=${item.videoId})\n\n${block}`;
  }
  return block;
}

// Gemini emits two equivalent shapes for numbered sub-headings:
//   `1. **Title**` followed by `   * sub-bullet`  (nests correctly in Notion)
//   `**1. Title**` followed by `* sub-bullet`     (renders flat in Notion)
// Rewrite the second shape into the first and indent any unindented sub-bullets
// that fall under a numbered head so the Notion converter nests them.
function normalizeNumberedSections(markdown) {
  const lines = markdown.split('\n');
  const out = [];
  let inNumberedSection = false;
  for (let line of lines) {
    const wrap = line.match(/^(\s*)\*\*(\d+)\.\s+(.+?)\*\*\s*$/);
    if (wrap) line = `${wrap[1]}${wrap[2]}. **${wrap[3]}**`;

    if (/^\s*\d+\.\s+\*\*/.test(line)) {
      inNumberedSection = true;
      out.push(line);
      continue;
    }
    // Any section heading or new bold label (e.g. **주요 타임라인**) ends the numbered scope.
    if (/^#{1,6}\s/.test(line) || /^\*\*[^*\n]+\*\*\s*$/.test(line) || /^---\s*$/.test(line)) {
      inNumberedSection = false;
      out.push(line);
      continue;
    }
    if (inNumberedSection && /^[*-]\s+/.test(line)) {
      out.push('   ' + line);
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

function classifyGeminiError(err) {
  const body = err.body || err.message || '';
  let parsed = null;
  try { parsed = JSON.parse(body); } catch {}
  const message = parsed?.error?.message || err.message || 'Unknown Gemini error';
  const status = parsed?.error?.status || '';
  const retryAfterMs = extractRetryAfterMs(message);
  const isQuota = err.status === 429 || status === 'RESOURCE_EXHAUSTED' || /quota|rate-limit|rate limit|RESOURCE_EXHAUSTED/i.test(message);
  return {
    isQuota,
    retryAfterMs,
    summary: `${err.status || 'ERR'} ${status ? `${status}: ` : ''}${message.split('\n')[0]}`.slice(0, 500)
  };
}

function quotaError({ videoTitle, errors, retryAfterMs = 0 }) {
  const retryText = retryAfterMs > 0 ? ` Gemini suggested retrying after ~${Math.ceil(retryAfterMs / 1000)}s.` : '';
  return new Error([
    `Every Gemini text model in the fallback chain hit quota while summarizing "${videoTitle}".${retryText}`,
    'This is an account/quota issue, not a bad model name.',
    'Options: wait for the free-tier quota window to reset, enable billing/increase quota, reduce collected videos (--max-per-channel), or use a different API key.',
    'Recent model attempts:',
    ...errors.slice(-10)
  ].join('\n'));
}

function extractRetryAfterMs(message) {
  const secondsMatch = String(message).match(/retry in\s+([\d.]+)s/i);
  if (secondsMatch) return Math.ceil(Number(secondsMatch[1]) * 1000);
  const msMatch = String(message).match(/retry in\s+([\d.]+)ms/i);
  if (msMatch) return Math.ceil(Number(msMatch[1]));
  return 0;
}

function compactErrorText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/"quotaMetric"\s*:\s*"[^"]+"/g, '"quotaMetric":"..."')
    .slice(0, 900);
}

function normalizeChannelHandle(channel) {
  const value = String(channel || '').trim();
  if (!value) return '@unknown';
  return value.startsWith('@') ? value : `@${value}`;
}

function normalizeModelName(modelName) {
  return String(modelName || '').replace(/^models\//, '').trim();
}

function isLikelyTextModel(model) {
  return /gemini/i.test(model) && !/(image|tts|embedding|veo|imagen|aqa)/i.test(model);
}

function compareGeminiPreference(a, b) {
  return modelScore(b) - modelScore(a) || a.localeCompare(b);
}

function modelScore(model) {
  const lower = model.toLowerCase();
  let score = 0;
  if (lower.includes('3.1')) score += 310;
  else if (lower.includes('3')) score += 300;
  if (lower.includes('2.5')) score += 250;
  if (lower.includes('2.0')) score += 200;
  if (lower.includes('fast')) score += 40;
  if (lower.includes('flash')) score += 30;
  if (lower.includes('lite')) score -= 10;
  if (lower.includes('latest')) score += 5;
  if (lower.includes('preview')) score -= 5;
  return score;
}

function unique(value, index, array) {
  return value && array.indexOf(value) === index;
}

function cleanMarkdown(markdown) {
  return markdown
    .replace(/^```(?:markdown|md)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
