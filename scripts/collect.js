#!/usr/bin/env node
/**
 * collect.js — Fetch recent YouTube videos using yt-dlp
 * Usage: node scripts/collect.js [--days N]
 *   --days 1  (default) → yesterday only → tmp/raw-YYYY-MM-DD.json
 *   --days 7            → last 7 days   → tmp/raw-YYYY-MM-DD_to_YYYY-MM-DD.json
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// Args
const argv = process.argv.slice(2);
const daysIdx = argv.indexOf('--days');
const days = daysIdx >= 0 ? Math.max(1, parseInt(argv[daysIdx + 1], 10) || 1) : 1;

// Date range: yesterday back to (yesterday - days + 1)
const endDate = new Date();
endDate.setDate(endDate.getDate() - 1);
const startDate = new Date(endDate);
startDate.setDate(startDate.getDate() - (days - 1));

const endStr = endDate.toISOString().split('T')[0];
const startStr = startDate.toISOString().split('T')[0];
const key = days > 1 ? `${startStr}_to_${endStr}` : endStr;

const channelsFile = path.join(ROOT, 'config', 'channels.txt');
const keywordsFile = path.join(ROOT, 'config', 'keywords.txt');
const tmpDir = path.join(ROOT, 'tmp');
const outputFile = path.join(tmpDir, `raw-${key}.json`);

fs.mkdirSync(tmpDir, { recursive: true });

// If YOUTUBE_COOKIES_B64 is set (from GitHub Secret in CI), decode to a temp file
// so yt-dlp can use authenticated cookies and bypass anonymous-access restrictions.
let cookiesFile = null;
if (process.env.YOUTUBE_COOKIES_B64) {
  cookiesFile = path.join(tmpDir, 'cookies.txt');
  fs.writeFileSync(cookiesFile, Buffer.from(process.env.YOUTUBE_COOKIES_B64, 'base64'));
  console.log(`🍪 Using YouTube cookies from env (${fs.statSync(cookiesFile).size} bytes)`);
}
const cookieArgs = cookiesFile ? ['--cookies', cookiesFile] : [];

const channels = fs.readFileSync(channelsFile, 'utf8')
  .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

const keywords = fs.existsSync(keywordsFile)
  ? fs.readFileSync(keywordsFile, 'utf8')
      .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  : [];

console.log(`📅 Range: ${startStr} → ${endStr} (${days} day${days > 1 ? 's' : ''})`);
console.log(`📺 Channels: ${channels.length}`);
console.log(`🔑 Keywords: ${keywords.length > 0 ? keywords.join(', ') : 'none (all videos)'}\n`);

const ytdlpCheck = spawnSync('yt-dlp', ['--version'], { encoding: 'utf8' });
if (ytdlpCheck.error || ytdlpCheck.status !== 0) {
  console.error('❌ yt-dlp not found in PATH. Install: https://github.com/yt-dlp/yt-dlp/releases');
  process.exit(1);
}

const startStrYtdlp = startStr.replace(/-/g, '');
const endStrYtdlp = endStr.replace(/-/g, '');

const results = [];
const PLAYLIST_END = Math.max(10, days * 5); // scan more videos when range is wider

for (const channel of channels) {
  const handle = channel.startsWith('@') ? channel : `@${channel}`;
  const url = `https://www.youtube.com/${handle}/videos`;

  console.log(`Fetching ${handle}...`);

  const listResult = spawnSync('yt-dlp', [
    ...cookieArgs,
    '--flat-playlist',
    '--print', '%(id)s',
    '--playlist-end', String(PLAYLIST_END),
    '--no-warnings',
    url
  ], { encoding: 'utf8', timeout: 60000 });

  if (listResult.status !== 0) {
    console.error(`  ❌ Failed to fetch: ${(listResult.stderr || '').split('\n')[0]}`);
    continue;
  }

  const videoIds = listResult.stdout.trim().split('\n').filter(Boolean);
  if (videoIds.length === 0) {
    console.log(`  ⏭️  No videos found`);
    continue;
  }

  let matched = 0;

  for (const videoId of videoIds) {
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    const metaResult = spawnSync('yt-dlp', [
      ...cookieArgs,
      '--dump-json',
      '--skip-download',
      '--no-warnings',
      videoUrl
    ], { encoding: 'utf8', timeout: 60000, maxBuffer: 50 * 1024 * 1024 });

    if (metaResult.status !== 0) continue;

    let video;
    try { video = JSON.parse(metaResult.stdout); } catch { continue; }

    const uploadDate = video.upload_date; // YYYYMMDD

    // Stop scanning once we go before the start date (videos are newest-first)
    if (uploadDate && uploadDate < startStrYtdlp) break;
    // Skip if outside range (newer than end date — shouldn't happen but safety)
    if (uploadDate && uploadDate > endStrYtdlp) continue;
    if (!uploadDate) continue;

    matched++;

    if (keywords.length > 0) {
      const titleLower = (video.title || '').toLowerCase();
      const descLower = (video.description || '').toLowerCase();
      const ok = keywords.some(kw =>
        titleLower.includes(kw.toLowerCase()) || descLower.includes(kw.toLowerCase())
      );
      if (!ok) {
        console.log(`  ⏭️  Skipped (no keyword): ${video.title}`);
        continue;
      }
    }

    let transcript = '';
    let hasTranscript = false;

    spawnSync('yt-dlp', [
      ...cookieArgs,
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

    const uploadDateStr = `${uploadDate.slice(0,4)}-${uploadDate.slice(4,6)}-${uploadDate.slice(6,8)}`;

    results.push({
      channel: handle,
      channelName: video.channel || video.uploader || handle,
      videoId,
      title: video.title || 'Untitled',
      views: video.view_count || 0,
      uploadDate: uploadDateStr,
      duration: video.duration || 0,
      transcript: transcript || video.description || '',
      description: video.description || '',
      hasTranscript
    });

    console.log(`  📝 [${uploadDateStr}] ${video.title} ${hasTranscript ? '' : '(desc only)'}`);
  }

  if (matched === 0) {
    console.log(`  ⏭️  No videos in range`);
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
