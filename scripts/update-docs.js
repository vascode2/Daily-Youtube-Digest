#!/usr/bin/env node
/**
 * update-docs.js — Reflect staged code changes into README.md and CLAUDE.md
 * using Gemini. Invoked from a git pre-commit hook.
 *
 * Behavior:
 *   1. Read staged diff (excluding the docs themselves and generated output).
 *   2. If the diff is empty / docs-only / trivial → no-op, exit 0.
 *   3. Ask Gemini to return a JSON envelope with full rewritten contents
 *      ONLY for files that genuinely need an update. If nothing needs to
 *      change, the model returns {"updates": []}.
 *   4. Write changed files and `git add` them so they're part of the commit.
 *
 * This script NEVER fails the commit on its own errors — if Gemini is
 * unreachable or returns garbage, we log and exit 0.
 *
 * Skip with:  SKIP_DOC_UPDATE=1 git commit ...
 *
 * Works both per-repo (invoked from this repo's .githooks/pre-commit) and
 * globally (invoked from a user-global hook that points at this script with
 * the env var DOC_UPDATER_SCRIPT). The script discovers the repo root via
 * `git rev-parse --show-toplevel`, so it doesn't depend on its own location.
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const REPO_ROOT = resolveRepoRoot();
if (!REPO_ROOT) {
  console.warn('update-docs: not inside a git repo → skipping');
  process.exit(0);
}

// Load .env from the repo so the hook has GEMINI_API_KEY when git runs it.
loadDotEnv(path.join(REPO_ROOT, '.env'));

const TARGET_DOCS = (process.env.DOC_UPDATER_TARGETS || 'README.md,CLAUDE.md')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const MODEL = process.env.GEMINI_DOCS_MODEL || 'gemini-2.5-flash';

if (process.env.SKIP_DOC_UPDATE === '1') {
  console.log('update-docs: SKIP_DOC_UPDATE=1 → skipping');
  process.exit(0);
}

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.warn('update-docs: GEMINI_API_KEY not set → skipping (commit will proceed)');
  process.exit(0);
}

// Only run in repos that actually have at least one target doc.
const presentDocs = TARGET_DOCS.filter(rel => fs.existsSync(path.join(REPO_ROOT, rel)));
if (presentDocs.length === 0) {
  console.log('update-docs: no target docs in this repo → skipping');
  process.exit(0);
}

let stagedFiles;
try {
  stagedFiles = git(['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
} catch (err) {
  console.warn('update-docs: could not read staged files →', err.message);
  process.exit(0);
}

// If everything staged is docs/generated/lock files, there's no code change to reflect.
const meaningful = stagedFiles.filter(f =>
  !TARGET_DOCS.includes(f) &&
  !f.startsWith('output/') &&
  !f.startsWith('tmp/') &&
  !f.startsWith('docs/') &&
  !f.endsWith('.lock') &&
  f !== 'package-lock.json'
);

if (meaningful.length === 0) {
  console.log('update-docs: no meaningful staged changes → skipping');
  process.exit(0);
}

let diff;
try {
  diff = git(['diff', '--cached', '--unified=3', '--', ...meaningful]);
} catch (err) {
  console.warn('update-docs: could not read staged diff →', err.message);
  process.exit(0);
}

if (!diff.trim()) {
  console.log('update-docs: empty diff → skipping');
  process.exit(0);
}

const MAX_DIFF_CHARS = 60_000;
let truncatedNote = '';
if (diff.length > MAX_DIFF_CHARS) {
  diff = diff.slice(0, MAX_DIFF_CHARS);
  truncatedNote = '\n[diff truncated]\n';
}

const docs = {};
for (const rel of presentDocs) {
  docs[rel] = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

const prompt = buildPrompt({ diff: diff + truncatedNote, docs, stagedFiles: meaningful });

console.log(`update-docs: asking ${MODEL} to review ${meaningful.length} staged file(s)…`);

let result;
try {
  result = await callGemini({ apiKey, model: MODEL, prompt });
} catch (err) {
  console.warn('update-docs: Gemini call failed →', err.message);
  process.exit(0);
}

const updates = parseUpdates(result);
if (!updates || updates.length === 0) {
  console.log('update-docs: model returned no updates');
  process.exit(0);
}

const written = [];
for (const u of updates) {
  if (!presentDocs.includes(u.path)) {
    console.warn(`update-docs: ignoring unexpected path "${u.path}"`);
    continue;
  }
  const abs = path.join(REPO_ROOT, u.path);
  const current = fs.readFileSync(abs, 'utf8');
  if (typeof u.content !== 'string' || u.content.trim().length === 0) {
    console.warn(`update-docs: empty content for ${u.path}, skipping`);
    continue;
  }
  if (u.content === current) continue;
  // Safety: refuse to shrink a doc by more than 50%.
  if (current.length > 200 && u.content.length < current.length * 0.5) {
    console.warn(`update-docs: refusing to write ${u.path} (shrinks ${current.length}→${u.content.length})`);
    continue;
  }
  fs.writeFileSync(abs, u.content, 'utf8');
  written.push(u.path);
}

if (written.length === 0) {
  console.log('update-docs: no files needed writing');
  process.exit(0);
}

try {
  git(['add', '--', ...written]);
} catch (err) {
  console.warn('update-docs: git add failed →', err.message);
  process.exit(0);
}

console.log('update-docs: updated', written.join(', '));

// ─── helpers ─────────────────────────────────────────────────────────────

function git(args) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024
  });
}

function resolveRepoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8'
    }).trim();
  } catch {
    return null;
  }
}

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    if (process.env[m[1]] !== undefined) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[m[1]] = val;
  }
}

function buildPrompt({ diff, docs, stagedFiles }) {
  const docSections = Object.entries(docs)
    .map(([name, content]) => `──────── CURRENT ${name} ────────\n${content}`)
    .join('\n\n');
  return `You are updating project documentation to reflect a code change that is about to be committed.

You will receive:
  1. The list of staged files.
  2. The unified diff of the staged changes (excluding the docs themselves).
  3. The CURRENT contents of each target doc.

Your job:
  - Decide whether the diff introduces something a reader of these docs would need to know
    (new feature, new command, changed workflow, new env var, removed script, changed default
     behavior, renamed file the doc references, etc.).
  - If yes, return the FULL updated contents of just the doc(s) that need to change.
  - If the change is purely internal (refactor, bug fix in an internal function, test-only,
    comment-only, cosmetic), return an empty updates array.

Rules:
  - Preserve the existing voice, tone, formatting, headings, links, and emoji of each doc.
  - Make the SMALLEST edit that accurately reflects the change. Do not rewrite unaffected sections.
  - Never invent features, commands, files, or env vars that aren't in the diff.
  - Keep markdown valid. Do not wrap the doc in code fences in your output.
  - Do NOT add a "Changelog" entry, "Recent changes" note, or timestamp. Just edit the relevant prose.

Output format — return ONE JSON object, no prose, no markdown fence:
{
  "updates": [
    { "path": "README.md", "content": "<full new file contents>" }
  ]
}

If no doc update is warranted, return exactly: {"updates": []}

──────── STAGED FILES ────────
${stagedFiles.join('\n')}

──────── STAGED DIFF ────────
${diff}

${docSections}
`;
}

async function callGemini({ apiKey, model, prompt }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json'
    }
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText} ${txt.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  if (!text) throw new Error('empty response from Gemini');
  return text;
}

function parseUpdates(text) {
  let raw = text.trim();
  const fenceMatch = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) raw = fenceMatch[1];
  try {
    const obj = JSON.parse(raw);
    if (!obj || !Array.isArray(obj.updates)) return [];
    return obj.updates;
  } catch (err) {
    console.warn('update-docs: could not parse JSON →', err.message);
    return [];
  }
}
