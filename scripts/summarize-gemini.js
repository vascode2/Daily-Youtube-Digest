#!/usr/bin/env node
/**
 * summarize-gemini.js — Generate tmp/summaries-*.md from the latest tmp/raw-*.json
 * using the fastest available Gemini model that supports generateContent.
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
  'gemini-3.0-flash',
  'gemini-3.0-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-1.5-flash'
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
const formatGuide = fs.readFileSync(path.join(ROOT, 'config', 'format.md'), 'utf8');
const summarizerGuide = fs.readFileSync(path.join(ROOT, 'agents', 'summarizer.md'), 'utf8');

console.log(`🔎 Resolving Gemini model, preferred: ${preferredModel}`);
const availableModels = await listGenerateContentModels(apiKey);
const modelCandidates = chooseModelCandidates({ preferredModel, fallbackModels, availableModels });

if (modelCandidates.length === 0) {
  console.error('❌ No Gemini models that support generateContent are available for this API key.');
  console.error('   Check the API key, billing/quota, and Google AI Studio model access.');
  process.exit(1);
}

console.log(`🧠 Summarizing ${rawItems.length} video(s)`);
console.log(`   Raw: ${path.relative(ROOT, rawFile)}`);
console.log(`   Model candidates: ${modelCandidates.join(', ')}`);

const prompt = buildPrompt({ key, rawItems, formatGuide, summarizerGuide });
const { markdown, model } = await generateWithFallback({ apiKey, modelCandidates, prompt });
const cleaned = cleanMarkdown(markdown);

fs.writeFileSync(summariesFile, cleaned.endsWith('\n') ? cleaned : `${cleaned}\n`);
console.log(`✅ Wrote: ${path.relative(ROOT, summariesFile)} using ${model}`);

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
    throw new Error(`Gemini ListModels failed (${response.status}): ${text.slice(0, 1000)}`);
  }

  const data = await response.json();
  return (data.models || [])
    .filter(model => (model.supportedGenerationMethods || []).includes('generateContent'))
    .map(model => normalizeModelName(model.name))
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
    .sort(compareGeminiPreference);

  return [...explicitCandidates, ...discoveredFastModels]
    .filter(unique);
}

async function generateWithFallback({ apiKey, modelCandidates, prompt }) {
  const errors = [];

  for (const model of modelCandidates) {
    try {
      console.log(`   Trying model: ${model}`);
      const markdown = await generateWithGemini({ apiKey, model, prompt });
      return { markdown, model };
    } catch (err) {
      errors.push(`${model}: ${err.message}`);
      console.warn(`   ⚠️  ${model} failed: ${err.message.slice(0, 300)}`);
    }
  }

  throw new Error(`All Gemini model candidates failed:\n${errors.join('\n')}`);
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

function normalizeModelName(modelName) {
  return String(modelName || '').replace(/^models\//, '').trim();
}

function compareGeminiPreference(a, b) {
  return modelScore(b) - modelScore(a) || a.localeCompare(b);
}

function modelScore(model) {
  const lower = model.toLowerCase();
  let score = 0;
  if (lower.includes('3')) score += 300;
  if (lower.includes('2.5')) score += 250;
  if (lower.includes('2.0')) score += 200;
  if (lower.includes('fast')) score += 40;
  if (lower.includes('flash')) score += 30;
  if (lower.includes('lite')) score -= 10;
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
