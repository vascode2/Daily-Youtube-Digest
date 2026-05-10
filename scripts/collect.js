#!/usr/bin/env node
/**
 * collect.js — Fetch recent YouTube videos using yt-dlp
 * Usage: node scripts/collect.js [--days N] [--date YYYY-MM-DD] [--from YYYY-MM-DD --to YYYY-MM-DD]
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
const maxPerChannelIdx = argv.indexOf('--max-per-channel');
const maxPerChannel = maxPerChannelIdx >= 0 ? Math.max(1, parseInt(argv[maxPerChannelIdx + 1], 10) || 0) : 0; // 0 = unlimited
const channelIdx = argv.indexOf('--channel');
const singleChannel = channelIdx >= 0 ? argv[channelIdx + 1] : null;
const limitIdx = argv.indexOf('--limit');
const limit = limitIdx >= 0 ? Math.max(1, parseInt(argv[limitIdx + 1], 10) || 10) : 10;
const dateIdx = argv.indexOf('--date');
const dateArg = dateIdx >= 0 ? argv[dateIdx + 1] : null;
const fromIdx = argv.indexOf('--from');
const toIdx = argv.indexOf('--to');
const fromArg = fromIdx >= 0 ? argv[fromIdx + 1] : null;
const toArg = toIdx >= 0 ? argv[toIdx + 1] : null;

// Date range. Default = UTC, but DIGEST_TIMEZONE env var can shift the
// reference timezone (e.g. "Asia/Seoul", "America/New_York", or numeric "+09:00", "-05:00").
// "Yesterday" is computed in this timezone.
const tzOffsetMs = parseTimezoneOffset(process.env.DIGEST_TIMEZONE);
const nowAdjusted = new Date(Date.now() + tzOffsetMs);
let endDate = new Date(nowAdjusted);
endDate.setUTCDate(endDate.getUTCDate() - 1);
let startDate = new Date(endDate);
startDate.setUTCDate(startDate.getUTCDate() - (days - 1));

if (!singleChannel && dateArg) {
  assertIsoDate(dateArg, '--date');
  startDate = new Date(`${dateArg}T00:00:00Z`);
  endDate = new Date(`${dateArg}T00:00:00Z`);
}

if (!singleChannel && fromArg && toArg) {
  assertIsoDate(fromArg, '--from');
  assertIsoDate(toArg, '--to');
  startDate = new Date(`${fromArg}T00:00:00Z`);
  endDate = new Date(`${toArg}T00:00:00Z`);
  if (startDate > endDate) {
    console.error('❌ --from must be earlier than or equal to --to');
    process.exit(1);
  }
}

const endStr = endDate.toISOString().split('T')[0];
const startStr = startDate.toISOString().split('T')[0];
const key = startStr === endStr ? endStr : `${startStr}_to_${endStr}`;

function parseTimezoneOffset(tz) {
  if (!tz) return 0; // UTC default
  // Numeric: "+09:00", "-05:00", "+9", "-5"
  const numMatch = String(tz).match(/^([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (numMatch) {
    const sign = numMatch[1] === '-' ? -1 : 1;
    const h = parseInt(numMatch[2], 10);
    const m = parseInt(numMatch[3] || '0', 10);
    return sign * (h * 60 + m) * 60 * 1000;
  }
  // Named timezone via Intl
  try {
    const d = new Date();
    const local = new Date(d.toLocaleString('en-US', { timeZone: tz }));
    const utc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
    return local.getTime() - utc.getTime();
  } catch {
    console.warn(`Unknown DIGEST_TIMEZONE "${tz}", falling back to UTC`);
    return 0;
  }
}

function assertIsoDate(dateValue, flagName) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
    console.error(`❌ ${flagName} must be YYYY-MM-DD format`);
    process.exit(1);
  }
}

const channelsFile = path.join(ROOT, 'config', 'channels.txt');
const keywordsFile = path.join(ROOT, 'config', 'keywords.txt');
const tmpDir = path.join(ROOT, 'tmp');

// Single-channel mode: ignore date range, fetch last N videos from one handle
let mode = 'multi';
let channelKey = null;
if (singleChannel) {
  mode = 'channel';
  const sanitized = singleChannel.replace(/^@/, '').replace(/[^A-Za-z0-9가-힣_-]/g, '');
  channelKey = `channel-${sanitized}-${endStr}`;
}
const outputFile = path.join(tmpDir, `raw-${mode === 'channel' ? channelKey : key}.json`);

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

// Channels list: from --channel arg (single) or channels.txt (multi)
const channels = mode === 'channel'
  ? [singleChannel]
  : fs.readFileSync(channelsFile, 'utf8')
      .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

const keywords = mode === 'channel'
  ? []  // no keyword filter in single-channel mode
  : (fs.existsSync(keywordsFile)
    ? fs.readFileSync(keywordsFile, 'utf8')
        .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    : []);

if (mode === 'channel') {
  console.log(`🎯 Channel mode: ${singleChannel}, last ${limit} videos (no date filter)`);
} else {
  console.log(`📅 Range: ${startStr} → ${endStr} (${days} day${days > 1 ? 's' : ''})`);
  console.log(`🌐 Timezone: ${process.env.DIGEST_TIMEZONE || 'UTC (default)'}`);
}
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
const PLAYLIST_END = mode === 'channel' ? limit : Math.max(10, days * 5);

for (const channel of channels) {
  const handle = channel.startsWith('@') ? channel : `@${channel}`;
  const url = `https://www.youtube.com/${handle}/videos`;

  console.log(`Fetching ${handle}...`);

  // Single call: fetch full metadata for the last N videos at once.
  // More robust than per-video metadata calls (which YouTube often rate-limits on cloud IPs).
  // --ignore-no-formats-error: don't fail when YouTube returns metadata without playable formats
  //   (we don't need formats — we just want title/upload_date/etc)
  // --extractor-args player_client=...: try multiple YouTube clients in order
  //   (some IPs/cookies are blocked on certain clients but work on others)
  const listResult = spawnSync('yt-dlp', [
    ...cookieArgs,
    '--dump-json',
    '--skip-download',
    '--ignore-no-formats-error',
    '--extractor-args', 'youtube:player_client=default,web,android,ios',
    '--playlist-end', String(PLAYLIST_END),
    '--ignore-errors',
    '--no-warnings',
    url
  ], { encoding: 'utf8', timeout: 180000, maxBuffer: 200 * 1024 * 1024 });

  if (listResult.status !== 0 && !listResult.stdout) {
    const stderr = (listResult.stderr || '').split('\n').filter(Boolean).slice(0, 3).join(' | ');
    console.error(`  ❌ yt-dlp failed: ${stderr.slice(0, 400)}`);
    continue;
  }
  if (listResult.stderr && listResult.stderr.length > 0) {
    const errLines = listResult.stderr.split('\n').filter(l => l.trim() && !l.includes('WARNING')).slice(0, 2).join(' | ');
    if (errLines) console.log(`  ⚠️  yt-dlp stderr: ${errLines.slice(0, 300)}`);
  }

  // Each line is one video's JSON
  const videos = listResult.stdout.split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);

  if (videos.length === 0) {
    console.log(`  ⏭️  No videos in metadata response`);
    continue;
  }
  console.log(`  → Got ${videos.length} videos with full metadata`);
  if (videos[0]) console.log(`     newest upload_date: ${videos[0].upload_date} (target: ${startStrYtdlp}..${endStrYtdlp})`);

  let matched = 0;
  let savedThisChannel = 0;

  for (const video of videos) {
    // Per-channel cap (counts videos actually saved, not just date-matched)
    const cap = mode === 'channel' ? limit : maxPerChannel;
    if (cap > 0 && savedThisChannel >= cap) {
      console.log(`  🛑 Reached cap of ${cap} videos for this channel`);
      break;
    }

    const videoId = video.id;
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    const uploadDate = video.upload_date;
    if (!uploadDate) continue;
    // In channel mode, skip date filtering (take all N most recent)
    if (mode !== 'channel') {
      if (uploadDate < startStrYtdlp) break;
      if (uploadDate > endStrYtdlp) continue;
    }

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
    let transcriptSegments = [];
    let hasTranscript = false;

    spawnSync('yt-dlp', [
      ...cookieArgs,
      '--write-auto-sub',
      '--sub-lang', 'en,ko',
      '--sub-format', 'vtt',
      '--skip-download',
      '--ignore-no-formats-error',
      '--extractor-args', 'youtube:player_client=default,web,android,ios',
      '--no-warnings',
      '-o', path.join(tmpDir, `%(id)s.%(ext)s`),
      videoUrl
    ], { encoding: 'utf8', timeout: 60000 });

    const vttFiles = fs.readdirSync(tmpDir).filter(f => f.startsWith(videoId) && f.endsWith('.vtt'));
    if (vttFiles.length > 0) {
      const vttContent = fs.readFileSync(path.join(tmpDir, vttFiles[0]), 'utf8');
      transcriptSegments = parseVTTSegments(vttContent);
      transcript = transcriptSegments.map(s => s.text).join(' ').replace(/\s+/g, ' ').trim();
      hasTranscript = transcriptSegments.length >= 3 && transcript.length > 100;
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
      transcriptSegments,
      description: video.description || '',
      hasTranscript
    });
    savedThisChannel++;

    console.log(`  📝 [${uploadDateStr}] ${video.title} ${hasTranscript ? '' : '(desc only)'}`);
  }

  if (matched === 0) {
    console.log(`  ⏭️  No videos in range`);
  }
}

fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
console.log(`\n✅ Saved ${results.length} videos to ${outputFile}`);

function parseVTTSegments(vtt) {
  const segments = [];
  const blocks = vtt.split(/\r?\n\r?\n+/);
  const seen = new Set();

  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const tsIdx = lines.findIndex(l => l.includes('-->'));
    if (tsIdx < 0) continue;

    const timeLine = lines[tsIdx];
    const m = timeLine.match(/^(\d{2}:\d{2}:\d{2}(?:\.\d{3})?)\s+-->\s+(\d{2}:\d{2}:\d{2}(?:\.\d{3})?)/);
    if (!m) continue;

    const text = lines
      .slice(tsIdx + 1)
      .map(l => l.replace(/<[^>]+>/g, '').trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!text) continue;

    const start = m[1].split('.')[0];
    const end = m[2].split('.')[0];
    const dedupKey = `${start}|${text}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    segments.push({ start, end, text });
  }

  return segments;
}
