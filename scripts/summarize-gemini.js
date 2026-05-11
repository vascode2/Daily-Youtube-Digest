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
const preferredModel = process.env.GEMINI_MODEL || 'gemini-3-fast';
const fallbackModels = (process.env.GEMINI_MODEL_FALLBACKS || [
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

for (let index = 0; index < rawItems.length; index++) {
  const item = rawItems[index];
  const handle = normalizeChannelHandle(item.channel);
  const channelKey = `${handle}\n${item.channelName || handle}`;
  if (!channelSections.has(channelKey)) {
    channelOrder.push(channelKey);
    channelSections.set(channelKey, {
      heading: `### 📺 [${item.channelName || handle}](https://www.youtube.com/${handle})`,
      videos: []
    });
  }

  console.log(`\n▶️  Video ${index + 1}/${rawItems.length}: ${item.title}`);
  const prompt = buildVideoPrompt(item);
  const result = await generateVideoWithFallback({
    apiKey,
    modelCandidates: selectedModel ? [selectedModel, ...modelCandidates.filter(model => model !== selectedModel)] : modelCandidates,
    prompt,
    videoTitle: item.title
  });
  selectedModel = result.model;
  channelSections.get(channelKey).videos.push(cleanVideoBlock(result.markdown, item));
  fs.writeFileSync(summariesFile, renderDigest({ key, channelOrder, channelSections }));
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

async function generateVideoWithFallback({ apiKey, modelCandidates, prompt, videoTitle }) {
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
          if (retryInfo.isQuota) throw quotaError({ videoTitle, errors, retryAfterMs: retryInfo.retryAfterMs });
        }
      }

      if (info.isQuota) throw quotaError({ videoTitle, errors, retryAfterMs: info.retryAfterMs });
    }
  }

  throw new Error(`All Gemini text model candidates failed for "${videoTitle}".\n${errors.join('\n')}`);
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
One Korean context sentence, then up to 3 numbered bold subheadings with exactly 1 bullet each.

Rules:
- Do not write **주요 타임라인**.
- Keep it short. The user will not read long summaries.
- Use maximum 3 numbered points and maximum 4 bullets total.
- Each bullet must be one compact sentence, roughly 35-55 Korean characters when possible.
- Include concrete names/companies/numbers/years from the transcript.
- Include at most one example/demo/case/comparison, only if it changes the core meaning.
- For transcriptSegments, add inline timestamp links like [[12:34](https://www.youtube.com/watch?v=${item.videoId}&t=754)] across early/middle/late meaningful parts, but do not list many timestamps.
- For long videos, do not cite only the first few minutes.
- If transcriptSegments are missing, write [자막 기반 타임라인 없음] once and do not invent timestamps.
- Do not include views, upload date, duration, or transcript indicators.
- Do not add FAE/takeaway/general advice that the video did not say.
- English source videos must still be summarized in Korean.

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

function renderDigest({ key, channelOrder, channelSections }) {
  const parts = [`# YouTube Digest — ${key}`, ''];
  for (const channelKey of channelOrder) {
    const section = channelSections.get(channelKey);
    parts.push(section.heading, '', section.videos.join('\n\n---\n\n'));
    parts.push('', '---', '');
  }
  return parts.join('\n').replace(/\n{4,}/g, '\n\n\n').trimEnd() + '\n';
}

function cleanVideoBlock(markdown, item) {
  let block = cleanMarkdown(markdown);
  block = block.replace(/^#\s+[^\n]+\n+/, '').trim();
  if (!/^##\s+\[/.test(block)) {
    block = `## [${item.title}](https://www.youtube.com/watch?v=${item.videoId})\n\n${block}`;
  }
  return block;
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

function quotaError({ videoTitle, errors, retryAfterMs }) {
  const retryText = retryAfterMs > 0 ? ` Gemini suggested retrying after ~${Math.ceil(retryAfterMs / 1000)}s.` : '';
  return new Error([
    `Gemini quota/rate limit exhausted while summarizing "${videoTitle}".${retryText}`,
    'This is an account/quota issue, not a bad model name.',
    'Options: wait for the free-tier quota window to reset, enable billing/increase quota, reduce collected videos, or use a different API key.',
    'Recent model attempts:',
    ...errors.slice(-5)
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
