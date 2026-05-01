#!/usr/bin/env node
/**
 * collect.js — Fetch yesterday's YouTube videos using yt-dlp
 * Reads: config/channels.txt, config/keywords.txt
 * Writes: tmp/raw-YYYY-MM-DD.json
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// Yesterday's date
const yesterday = new Date();
yesterday.setDate(yesterday.getDate() - 1);
const dateStr = yesterday.toISOString().split('T')[0]; // YYYY-MM-DD
const ytdlpDate = dateStr.replace(/-/g, '');           // YYYYMMDD

const channelsFile = path.join(ROOT, 'config', 'channels.txt');
const keywordsFile = path.join(ROOT, 'config', 'keywords.txt');
const tmpDir = path.join(ROOT, 'tmp');
const outputFile = path.join(tmpDir, `raw-${dateStr}.json`);

fs.mkdirSync(tmpDir, { recursive: true });

const channels = fs.readFileSync(channelsFile, 'utf8')
  .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

const keywords = fs.existsSync(keywordsFile)
  ? fs.readFileSync(keywordsFile, 'utf8')
      .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  : [];

console.log(`📅 Target date: ${dateStr}`);
console.log(`📺 Channels: ${channels.length}`);
console.log(`🔑 Keywords: ${keywords.length > 0 ? keywords.join(', ') : 'none (all videos)'}\n`);

// Verify yt-dlp once upfront
const ytdlpCheck = spawnSync('yt-dlp', ['--version'], { encoding: 'utf8' });
if (ytdlpCheck.error || ytdlpCheck.status !== 0) {
  console.error('❌ yt-dlp not found in PATH. Install: https://github.com/yt-dlp/yt-dlp/releases');
  process.exit(1);
}

const results = [];
const PLAYLIST_END = 10; // check most recent 10 videos per channel

for (const channel of channels) {
  const handle = channel.startsWith('@') ? channel : `@${channel}`;
  const url = `https://www.youtube.com/${handle}/videos`;

  console.log(`Fetching ${handle}...`);

  // Step 1: get last N video IDs (flat-playlist is fast)
  const listResult = spawnSync('yt-dlp', [
    '--flat-playlist',
    '--print', '%(id)s',
    '--playlist-end', String(PLAYLIST_END),
    '--no-warnings',
    url
  ], { encoding: 'utf8', timeout: 60000 });

  if (listResult.status !== 0) {
    console.error(`  ❌ Failed to fetch channel: ${(listResult.stderr || '').split('\n')[0]}`);
    continue;
  }

  const videoIds = listResult.stdout.trim().split('\n').filter(Boolean);
  if (videoIds.length === 0) {
    console.log(`  ⏭️  No videos found`);
    continue;
  }

  // Step 2: for each video, get full metadata (with upload_date) and filter
  let matchedYesterday = 0;

  for (const videoId of videoIds) {
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    const metaResult = spawnSync('yt-dlp', [
      '--dump-json',
      '--skip-download',
      '--no-warnings',
      videoUrl
    ], { encoding: 'utf8', timeout: 60000, maxBuffer: 50 * 1024 * 1024 });

    if (metaResult.status !== 0) continue;

    let video;
    try { video = JSON.parse(metaResult.stdout); } catch { continue; }

    // Filter by upload date (yesterday only)
    if (video.upload_date !== ytdlpDate) {
      // The list is newest-first; once we see an older video, stop
      if (video.upload_date && video.upload_date < ytdlpDate) break;
      continue;
    }

    matchedYesterday++;

    // Keyword filter
    if (keywords.length > 0) {
      const titleLower = (video.title || '').toLowerCase();
      const descLower = (video.description || '').toLowerCase();
      const matched = keywords.some(kw =>
        titleLower.includes(kw.toLowerCase()) || descLower.includes(kw.toLowerCase())
      );
      if (!matched) {
        console.log(`  ⏭️  Skipped (no keyword match): ${video.title}`);
        continue;
      }
    }

    // Step 3: get transcript
    let transcript = '';
    let hasTranscript = false;

    spawnSync('yt-dlp', [
      '--write-auto-sub',
      '--sub-lang', 'en,ko',
      '--sub-format', 'vtt',
      '--skip-download',
      '--no-warnings',
      '-o', path.join(tmpDir, `%(id)s.%(ext)s`),
      videoUrl
    ], { encoding: 'utf8', timeout: 60000 });

    const vttFiles = fs.readdirSync(tmpDir).filter(f => f.startsWith(videoId) && f.endsWith('.vtt'));
    if (vttFiles.length > 0) {
      const vttContent = fs.readFileSync(path.join(tmpDir, vttFiles[0]), 'utf8');
      transcript = parseVTT(vttContent);
      hasTranscript = transcript.length > 100;
      vttFiles.forEach(f => fs.unlinkSync(path.join(tmpDir, f)));
    }

    results.push({
      channel: handle,
      videoId,
      title: video.title || 'Untitled',
      views: video.view_count || 0,
      uploadDate: dateStr,
      duration: video.duration || 0,
      transcript: transcript || video.description || '',
      description: video.description || '',
      hasTranscript
    });

    console.log(`  📝 ${video.title} [${hasTranscript ? 'transcript' : 'desc only'}]`);
  }

  if (matchedYesterday === 0) {
    console.log(`  ⏭️  No videos uploaded on ${dateStr}`);
  }
}

fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
console.log(`\n✅ Saved ${results.length} videos to ${outputFile}`);

function parseVTT(vtt) {
  const seen = new Set();
  return vtt
    .split('\n')
    .filter(l => !l.includes('-->') && !l.startsWith('WEBVTT') && !l.startsWith('NOTE') && !l.match(/^Kind:|^Language:/) && l.trim())
    .map(l => l.replace(/<[^>]+>/g, '').trim())
    .filter(l => {
      if (!l || seen.has(l)) return false;
      seen.add(l);
      return true;
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
