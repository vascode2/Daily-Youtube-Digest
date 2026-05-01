#!/usr/bin/env node
/**
 * collect.js — Fetch yesterday's YouTube videos using yt-dlp
 * Reads: config/channels.txt, config/keywords.txt
 * Writes: tmp/raw-YYYY-MM-DD.json
 */

import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// Yesterday's date in yt-dlp format (YYYYMMDD)
const yesterday = new Date();
yesterday.setDate(yesterday.getDate() - 1);
const dateStr = yesterday.toISOString().split('T')[0]; // YYYY-MM-DD
const ytdlpDate = dateStr.replace(/-/g, '');           // YYYYMMDD

const channelsFile = path.join(ROOT, 'config', 'channels.txt');
const keywordsFile = path.join(ROOT, 'config', 'keywords.txt');
const tmpDir = path.join(ROOT, 'tmp');
const outputFile = path.join(tmpDir, `raw-${dateStr}.json`);

fs.mkdirSync(tmpDir, { recursive: true });

// Load channels (skip comments and empty lines)
const channels = fs.readFileSync(channelsFile, 'utf8')
  .split('\n')
  .map(l => l.trim())
  .filter(l => l && !l.startsWith('#'));

// Load keywords (empty = no filter)
const keywords = fs.existsSync(keywordsFile)
  ? fs.readFileSync(keywordsFile, 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
  : [];

console.log(`📅 Collecting videos for: ${dateStr}`);
console.log(`📺 Channels: ${channels.length}`);
console.log(`🔑 Keywords: ${keywords.length > 0 ? keywords.join(', ') : 'none (all videos)'}\n`);

const results = [];

for (const channel of channels) {
  const handle = channel.startsWith('@') ? channel : `@${channel}`;
  const url = `https://www.youtube.com/${handle}/videos`;

  console.log(`Fetching ${handle}...`);

  try {
    // Get video list
    const listResult = spawnSync('yt-dlp', [
      '--flat-playlist',
      '--dump-json',
      '--dateafter', `${ytdlpDate}`,
      '--datebefore', `${ytdlpDate}`,
      '--no-warnings',
      url
    ], { encoding: 'utf8', timeout: 60000 });

    if (listResult.error) {
      console.error(`  ❌ yt-dlp not found. Install: pip install yt-dlp`);
      continue;
    }

    const videos = listResult.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);

    if (videos.length === 0) {
      console.log(`  ⏭️  No videos yesterday`);
      continue;
    }

    console.log(`  ✅ Found ${videos.length} video(s)`);

    for (const video of videos) {
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

      // Get transcript
      let transcript = '';
      let hasTranscript = false;
      const videoUrl = `https://www.youtube.com/watch?v=${video.id}`;

      const subResult = spawnSync('yt-dlp', [
        '--write-auto-sub',
        '--sub-lang', 'en,ko',
        '--sub-format', 'vtt',
        '--skip-download',
        '--no-warnings',
        '-o', path.join(tmpDir, `%(id)s.%(ext)s`),
        videoUrl
      ], { encoding: 'utf8', timeout: 60000 });

      // Read transcript file if created
      const vttFiles = fs.readdirSync(tmpDir).filter(f => f.startsWith(video.id) && f.endsWith('.vtt'));
      if (vttFiles.length > 0) {
        const vttContent = fs.readFileSync(path.join(tmpDir, vttFiles[0]), 'utf8');
        transcript = parseVTT(vttContent);
        hasTranscript = true;
        vttFiles.forEach(f => fs.unlinkSync(path.join(tmpDir, f)));
      }

      results.push({
        channel: handle,
        videoId: video.id,
        title: video.title || 'Untitled',
        views: video.view_count || 0,
        uploadDate: dateStr,
        duration: video.duration || 0,
        transcript: transcript || video.description || '',
        description: video.description || '',
        hasTranscript
      });

      console.log(`  📝 ${video.title} [${hasTranscript ? 'transcript' : 'description only'}]`);
    }
  } catch (err) {
    console.error(`  ❌ Error: ${err.message}`);
  }
}

fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
console.log(`\n✅ Saved ${results.length} videos to ${outputFile}`);

function parseVTT(vtt) {
  return vtt
    .split('\n')
    .filter(l => !l.includes('-->') && !l.startsWith('WEBVTT') && !l.startsWith('NOTE') && l.trim())
    .map(l => l.replace(/<[^>]+>/g, '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
