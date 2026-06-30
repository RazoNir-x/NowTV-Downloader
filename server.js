const express = require('express');
const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = 3000;
const DOWNLOADS_DIR = 'F:\\RWS-Netflix\\Turk shows';

// Active batch sessions
const batchSessions = new Map();

// Timing helper
function formatDuration(ms) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
  return `${m}:${String(s % 60).padStart(2,'0')}`;
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────

function parseNowTVUrl(url) {
  try {
    const urlObj = new URL(url);
    const parts = urlObj.pathname.split('/').filter(Boolean);
    if (parts.length >= 3 && parts[1].toLowerCase() === 'bolum') {
      return { showName: parts[0], episode: parseInt(parts[2], 10) };
    }
    const lastPart = parts[parts.length - 1];
    const num = parseInt(lastPart, 10);
    return { showName: parts[0] || 'Unknown', episode: isNaN(num) ? 1 : num };
  } catch (e) {
    return { showName: 'Unknown', episode: 1 };
  }
}

function buildEpisodeUrl(baseUrl, episodeNum) {
  try {
    const urlObj = new URL(baseUrl);
    const parts = urlObj.pathname.split('/').filter(Boolean);
    if (parts.length >= 3 && parts[1].toLowerCase() === 'bolum') {
      parts[2] = String(episodeNum);
    }
    urlObj.pathname = '/' + parts.join('/');
    return urlObj.toString();
  } catch (e) {
    return baseUrl.replace(/\/\d+$/, '/' + episodeNum);
  }
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(destPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);
    protocol.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) { reject(new Error(`HTTP ${response.statusCode}`)); return; }
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(destPath); });
    }).on('error', (err) => { fs.unlink(destPath, () => {}); reject(err); });
  });
}

function sendSSE(res, event, data) {
  if (res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Check if episode already exists in show folder
function episodeExists(showName, episode) {
  const showDir = path.join(DOWNLOADS_DIR, showName);
  if (!fs.existsSync(showDir)) return false;
  
  const epStr = String(episode).padStart(2, '0');
  // Search recursively for any video file matching the episode
  const patterns = [
    `E${epStr}`, `E${episode}`, 
    `_${epStr}.`, `_${episode}.`,
    `Episode ${episode}`, `episode_${episode}`,
    `פרק ${episode}`, `פרק_${episode}`
  ];

  function searchDir(dir) {
    try {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          if (searchDir(fullPath)) return true;
        } else {
          const ext = path.extname(item).toLowerCase();
          if (['.mp4', '.mkv', '.ts', '.avi', '.webm'].includes(ext)) {
            for (const pattern of patterns) {
              if (item.includes(pattern)) return true;
            }
          }
        }
      }
    } catch (e) {}
    return false;
  }

  return searchDir(showDir);
}

// ─────────────────────────────────────────────
// CAPTURE m3u8 + vtt FROM PAGE
// ─────────────────────────────────────────────

async function captureStreamUrls(pageUrl, broadcastFn) {
  let browser;
  try {
    broadcastFn('log', { message: '🌐 מפעיל דפדפן...' });
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security', '--disable-features=VizDisplayCompositor']
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });

    let m3u8Url = null;
    let vttUrl = null;

    const cdp = await page.createCDPSession();
    await cdp.send('Network.enable');

    cdp.on('Network.requestWillBeSent', (params) => {
      const reqUrl = params.request.url;
      if (reqUrl.includes('playlist.m3u8') && !m3u8Url) {
        m3u8Url = reqUrl;
        broadcastFn('log', { message: `✅ נמצא וידאו: ...${reqUrl.slice(-60)}` });
      }
      if (reqUrl.includes('.vtt') && !vttUrl) {
        vttUrl = reqUrl;
        broadcastFn('log', { message: `✅ נמצאו כתוביות` });
      }
    });

    broadcastFn('log', { message: `📄 נכנס לדף: ${pageUrl}` });
    await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    // Cookie consent
    for (const sel of ['#onetrust-accept-btn-handler', '.onetrust-close-btn-handler']) {
      try {
        const btn = await page.$(sel);
        if (btn) { await btn.click(); broadcastFn('log', { message: '🍪 אישרתי קוקיז' }); await new Promise(r => setTimeout(r, 1000)); break; }
      } catch (e) {}
    }

    // Play video
    try {
      await page.waitForSelector('video, #foxPlayer, .video-js', { timeout: 15000 });
      await page.evaluate(() => { const v = document.querySelector('video'); if (v) { v.muted = true; v.play().catch(() => {}); } });
    } catch (e) {}

    const playSelectors = [
      '#foxPlayer .vjs-big-play-button', '.vjs-big-play-button', '.video-js .vjs-big-play-button',
      '.video-player .vjs-big-play-button', '.vod-player .vjs-big-play-button', '#foxPlayer',
      '.play-button', 'button[aria-label*="play"]', 'button[aria-label*="Play"]', 'button[aria-label*="Oynat"]'
    ];
    async function tryClickPlay() {
      for (const s of playSelectors) {
        try { const b = await page.$(s); if (b) { await b.click(); return true; } } catch (e) {}
      }
      return false;
    }
    await tryClickPlay();

    // Wait for m3u8
    const startTime = Date.now();
    while (!m3u8Url && (Date.now() - startTime) < 45000) {
      await new Promise(r => setTimeout(r, 1000));
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      if (elapsed % 5 === 0) { broadcastFn('log', { message: `⏳ מחפש... (${elapsed}s)` }); await tryClickPlay(); }
    }

    await browser.close();
    browser = null;
    return { m3u8Url, vttUrl };
  } catch (err) {
    broadcastFn('log', { message: `❌ שגיאה: ${err.message}` });
    return { m3u8Url: null, vttUrl: null };
  } finally {
    if (browser) try { await browser.close(); } catch (e) {}
  }
}

// ─────────────────────────────────────────────
// DOWNLOAD SINGLE EPISODE
// ─────────────────────────────────────────────

async function downloadEpisode(m3u8Url, vttUrl, showName, episode, downloadDir, broadcastFn) {
  const epStr = String(episode).padStart(2, '0');
  const videoFilePath = path.join(downloadDir, `${showName}_E${epStr}`);

  // Download video with concurrent fragment downloads for speed
  await new Promise((resolve, reject) => {
    const ytdlp = spawn('yt-dlp', [
      m3u8Url,
      '-o', `${videoFilePath}.%(ext)s`,
      '--no-check-certificates', '--no-update', '--newline', '--progress',
      '--concurrent-fragments', '5',
      '--referer', 'https://www.nowtv.com.tr/',
      '--add-header', 'Origin: https://www.nowtv.com.tr'
    ], { cwd: downloadDir, windowsHide: true });

    ytdlp.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        broadcastFn('ytdlp', { message: line.trim(), episode });
        const match = line.match(/(\d+\.?\d*)%/);
        if (match) broadcastFn('episode_progress', { episode, percent: parseFloat(match[1]) });
      }
    });
    ytdlp.stderr.on('data', (data) => {
      data.toString().split('\n').filter(Boolean).forEach(l => broadcastFn('ytdlp', { message: l.trim(), episode }));
    });
    ytdlp.on('close', (code) => {
      if (code === 0) broadcastFn('log', { message: `✅ וידאו פרק ${episode} הורד!` });
      else broadcastFn('log', { message: `⚠️ yt-dlp קוד יציאה: ${code}` });
      resolve();
    });
    ytdlp.on('error', (err) => { broadcastFn('log', { message: `❌ yt-dlp: ${err.message}` }); resolve(); });
  });

  // Download subtitles
  if (vttUrl) {
    try {
      const subtitlePath = path.join(downloadDir, `${showName}_E${epStr}.txt`);
      await downloadFile(vttUrl, subtitlePath);
      broadcastFn('log', { message: `✅ כתוביות פרק ${episode} נשמרו` });
    } catch (err) {
      broadcastFn('log', { message: `⚠️ כתוביות: ${err.message}` });
    }
  }
}

// ─────────────────────────────────────────────
// API: BATCH DOWNLOAD
// ─────────────────────────────────────────────

app.post('/api/batch', (req, res) => {
  const { url, fromEpisode, toEpisode } = req.body;
  if (!url || !url.includes('nowtv.com.tr')) return res.status(400).json({ error: 'Invalid URL' });

  const { showName } = parseNowTVUrl(url);
  const from = fromEpisode || parseNowTVUrl(url).episode;
  const to = toEpisode || from;

  if (to < from) return res.status(400).json({ error: 'End episode must be >= start' });

  const sessionId = uuidv4();
  const episodes = [];
  for (let i = from; i <= to; i++) {
    const exists = episodeExists(showName, i);
    episodes.push({ episode: i, status: exists ? 'exists' : 'pending', percent: 0 });
  }

  const session = {
    id: sessionId, url, showName, from, to,
    episodes, status: 'pending', listeners: [], logs: []
  };
  batchSessions.set(sessionId, session);
  res.json({ sessionId, showName, episodes });
});

// SSE endpoint for batch progress
app.get('/api/batch/progress/:id', (req, res) => {
  const session = batchSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Not found' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  // Send current state
  sendSSE(res, 'init', { showName: session.showName, episodes: session.episodes });
  for (const log of session.logs) sendSSE(res, log.event, log.data);

  session.listeners.push(res);
  req.on('close', () => { session.listeners = session.listeners.filter(l => l !== res); });

  if (session.status === 'pending') {
    session.status = 'running';
    runBatchDownload(session);
  }
});

function broadcast(session, event, data) {
  session.logs.push({ event, data });
  for (const l of session.listeners) sendSSE(l, event, data);
}

async function runBatchDownload(session) {
  const { url, showName, episodes } = session;
  const downloadDir = path.join(DOWNLOADS_DIR, showName);
  if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

  const broadcastFn = (event, data) => broadcast(session, event, data);
  const totalToDownload = episodes.filter(e => e.status === 'pending').length;
  const skipped = episodes.filter(e => e.status === 'exists').length;
  const batchStartTime = Date.now();
  const episodeTimes = []; // track ms per completed episode for ETA

  broadcastFn('log', { message: `📂 תיקיית יעד: ${downloadDir}` });
  broadcastFn('log', { message: `📋 ${episodes.length} פרקים, ${skipped} כבר קיימים, ${totalToDownload} להורדה` });
  broadcastFn('log', { message: `⚡ מצב מהיר: 5 חלקים במקביל + pipeline` });
  broadcastFn('timing', { elapsed: '0:00', eta: '--:--', avgPerEp: '--:--', downloaded: 0, total: totalToDownload });

  let downloadedCount = 0;
  const pendingEpisodes = episodes.filter(e => e.status === 'pending');

  // Handle skipped episodes first
  for (const ep of episodes) {
    if (ep.status === 'exists') {
      broadcastFn('episode_status', { episode: ep.episode, status: 'exists' });
      broadcastFn('log', { message: `⏭️ פרק ${ep.episode} כבר קיים — דילוג` });
    }
  }

  // PIPELINE: capture next episode's URLs while current one downloads
  let prefetchedUrls = null; // { m3u8Url, vttUrl } for the NEXT episode
  let prefetchPromise = null;

  for (let i = 0; i < pendingEpisodes.length; i++) {
    const ep = pendingEpisodes[i];
    const nextEp = pendingEpisodes[i + 1] || null;
    const epStartTime = Date.now();

    ep.status = 'downloading';
    broadcastFn('episode_status', { episode: ep.episode, status: 'downloading' });
    broadcastFn('log', { message: `\n━━━ פרק ${ep.episode} (${downloadedCount + 1}/${totalToDownload}) ━━━` });

    // Get URLs: use prefetched if available, otherwise capture now
    let m3u8Url, vttUrl;
    if (prefetchedUrls) {
      broadcastFn('log', { message: `⚡ משתמש ב-URL שכבר נמצא מראש` });
      ({ m3u8Url, vttUrl } = prefetchedUrls);
      prefetchedUrls = null;
    } else {
      const pageUrl = buildEpisodeUrl(url, ep.episode);
      broadcastFn('log', { message: `🔍 מחפש וידאו עבור פרק ${ep.episode}...` });
      ({ m3u8Url, vttUrl } = await captureStreamUrls(pageUrl, broadcastFn));
    }

    if (!m3u8Url) {
      ep.status = 'error';
      broadcastFn('episode_status', { episode: ep.episode, status: 'error' });
      broadcastFn('log', { message: `❌ פרק ${ep.episode}: לא נמצא וידאו` });
      prefetchedUrls = null;
      continue;
    }

    // Start prefetching NEXT episode's URLs in parallel with current download
    if (nextEp) {
      const nextPageUrl = buildEpisodeUrl(url, nextEp.episode);
      broadcastFn('log', { message: `🔮 מחפש מראש את פרק ${nextEp.episode} במקביל...` });
      // Silent broadcast for prefetch (don't flood the log)
      const silentBroadcast = (event, data) => {
        if (event === 'log' && !data.message.includes('✅')) return; // only show found messages
        broadcastFn(event, data);
      };
      prefetchPromise = captureStreamUrls(nextPageUrl, silentBroadcast);
    }

    // Download current episode
    broadcastFn('log', { message: `📥 מוריד פרק ${ep.episode}...` });
    await downloadEpisode(m3u8Url, vttUrl, showName, ep.episode, downloadDir, broadcastFn);

    const epDuration = Date.now() - epStartTime;
    episodeTimes.push(epDuration);
    ep.status = 'complete';
    ep.percent = 100;
    downloadedCount++;

    // Calculate timing
    const totalElapsed = Date.now() - batchStartTime;
    const avgPerEp = episodeTimes.reduce((a, b) => a + b, 0) / episodeTimes.length;
    const remaining = totalToDownload - downloadedCount;
    const eta = remaining * avgPerEp;

    broadcastFn('episode_status', { episode: ep.episode, status: 'complete' });
    broadcastFn('episode_time', { episode: ep.episode, duration: formatDuration(epDuration) });
    broadcastFn('batch_progress', { downloaded: downloadedCount, total: totalToDownload, skipped });
    broadcastFn('timing', {
      elapsed: formatDuration(totalElapsed),
      eta: remaining > 0 ? formatDuration(eta) : '0:00',
      avgPerEp: formatDuration(avgPerEp),
      downloaded: downloadedCount,
      total: totalToDownload
    });
    broadcastFn('log', { message: `⏱️ פרק ${ep.episode}: ${formatDuration(epDuration)} | כללי: ${formatDuration(totalElapsed)} | ETA: ${remaining > 0 ? formatDuration(eta) : 'הושלם'}` });

    // Wait for prefetch to complete if it's still running
    if (prefetchPromise) {
      prefetchedUrls = await prefetchPromise;
      prefetchPromise = null;
    }

    // Minimal delay between episodes (prefetch already bought us time)
    if (downloadedCount < totalToDownload) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  const totalTime = Date.now() - batchStartTime;
  session.status = 'complete';
  broadcastFn('batch_complete', {
    showName,
    downloaded: downloadedCount,
    skipped,
    errors: episodes.filter(e => e.status === 'error').length,
    downloadDir,
    totalTime: formatDuration(totalTime),
    avgPerEp: episodeTimes.length > 0 ? formatDuration(episodeTimes.reduce((a,b) => a+b, 0) / episodeTimes.length) : '0:00'
  });
  broadcastFn('log', { message: `\n🎉 הושלם! ${downloadedCount} פרקים ב-${formatDuration(totalTime)}` });
}

// ─────────────────────────────────────────────
// API: LIBRARY (browse existing downloads)
// ─────────────────────────────────────────────

app.get('/api/library', (req, res) => {
  const library = [];
  if (!fs.existsSync(DOWNLOADS_DIR)) return res.json([]);

  try {
    const shows = fs.readdirSync(DOWNLOADS_DIR);
    for (const show of shows) {
      const showDir = path.join(DOWNLOADS_DIR, show);
      if (!fs.statSync(showDir).isDirectory()) continue;

      const seasons = {};  // seasonName -> { videos: [], subtitles: { txt: [], vtt: [] } }
      const ROOT = '__root__';

      function scanDir(dir, depth = 0) {
        if (depth > 3) return;
        try {
          const items = fs.readdirSync(dir);
          for (const item of items) {
            const fullPath = path.join(dir, item);
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
              scanDir(fullPath, depth + 1);
            } else {
              const ext = path.extname(item).toLowerCase();
              const rel = path.relative(showDir, dir) || ROOT;
              if (!seasons[rel]) seasons[rel] = { videos: [], subtitles: { txt: 0, vtt: 0 } };

              if (['.mp4', '.mkv', '.ts', '.avi', '.webm'].includes(ext)) {
                const sizeGB = (stat.size / (1024 * 1024 * 1024)).toFixed(2);
                seasons[rel].videos.push({
                  name: item, size: `${sizeGB} GB`, sizeBytes: stat.size, path: fullPath
                });
              } else if (ext === '.txt') {
                // Check if it's a VTT subtitle file
                try {
                  const head = fs.readFileSync(fullPath, 'utf8').substring(0, 50);
                  if (head.includes('WEBVTT')) seasons[rel].subtitles.txt++;
                } catch (e) {}
              } else if (ext === '.vtt') {
                seasons[rel].subtitles.vtt++;
              }
            }
          }
        } catch (e) {}
      }
      scanDir(showDir);

      // Build show entry
      const seasonList = [];
      let totalEpisodes = 0;
      let totalSize = 0;
      let totalTxt = 0;
      let totalVtt = 0;

      for (const [seasonName, data] of Object.entries(seasons)) {
        if (data.videos.length === 0) continue;
        data.videos.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        const seasonSize = data.videos.reduce((s, v) => s + v.sizeBytes, 0);
        totalSize += seasonSize;
        totalEpisodes += data.videos.length;
        totalTxt += data.subtitles.txt;
        totalVtt += data.subtitles.vtt;
        seasonList.push({
          name: seasonName === ROOT ? null : seasonName,
          episodeCount: data.videos.length,
          totalSize: `${(seasonSize / (1024 * 1024 * 1024)).toFixed(2)} GB`,
          subtitlesTxt: data.subtitles.txt,
          subtitlesVtt: data.subtitles.vtt,
          episodes: data.videos
        });
      }

      if (totalEpisodes > 0) {
        seasonList.sort((a, b) => {
          if (!a.name) return -1;
          if (!b.name) return 1;
          return a.name.localeCompare(b.name, undefined, { numeric: true });
        });
        library.push({
          showName: show,
          episodeCount: totalEpisodes,
          totalSize: `${(totalSize / (1024 * 1024 * 1024)).toFixed(2)} GB`,
          subtitlesTxt: totalTxt,
          subtitlesVtt: totalVtt,
          seasons: seasonList
        });
      }
    }
  } catch (e) {}

  library.sort((a, b) => a.showName.localeCompare(b.showName));
  res.json(library);
});

// ─────────────────────────────────────────────
// TRANSLATION ENGINE
// ─────────────────────────────────────────────

// Parse VTT content into blocks
function parseVTT(content) {
  const blocks = [];
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  let i = 0;

  // Skip WEBVTT header and NOTE
  while (i < lines.length && !lines[i].includes('-->')) i++;

  while (i < lines.length) {
    // Find timestamp line
    if (!lines[i].includes('-->')) { i++; continue; }

    // Check if line before timestamp is an index number
    let index = null;
    if (i > 0 && /^\d+$/.test(lines[i - 1].trim())) {
      index = lines[i - 1].trim();
    }

    const timestamp = lines[i];
    i++;

    // Collect text lines until empty line
    const textLines = [];
    while (i < lines.length && lines[i].trim() !== '') {
      textLines.push(lines[i]);
      i++;
    }

    blocks.push({ index, timestamp, text: textLines.join('\n') });
  }

  return blocks;
}

// Build VTT file from blocks
function buildVTT(blocks) {
  let vtt = 'WEBVTT\n\n';
  for (let i = 0; i < blocks.length; i++) {
    vtt += `${i + 1}\n`;
    vtt += `${blocks[i].timestamp}\n`;
    vtt += `${blocks[i].text}\n\n`;
  }
  return vtt;
}

// Translate text via Google Translate (free API)
async function googleTranslate(text, from = 'tr', to = 'he') {
  return new Promise((resolve, reject) => {
    const encoded = encodeURIComponent(text);
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encoded}`;

    https.get(url, (response) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          // Response format: [[[translated, original, ...], ...], ...]
          let translated = '';
          if (parsed && parsed[0]) {
            for (const seg of parsed[0]) {
              if (seg[0]) translated += seg[0];
            }
          }
          resolve(translated);
        } catch (e) {
          reject(new Error(`Parse error: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

// Translate subtitle blocks in batches
async function translateSubtitleBlocks(blocks, broadcastFn) {
  const BATCH_SIZE = 30; // lines per batch (to stay under Google's char limit)
  const SEPARATOR = '\n🔹\n'; // unique separator that won't be in subtitles
  const translated = [...blocks];
  let batchCount = 0;
  const totalBatches = Math.ceil(blocks.length / BATCH_SIZE);

  for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
    const batch = blocks.slice(i, i + BATCH_SIZE);
    const batchText = batch.map(b => b.text).join(SEPARATOR);

    batchCount++;
    broadcastFn('translate_progress', {
      current: Math.min(i + BATCH_SIZE, blocks.length),
      total: blocks.length,
      batch: batchCount,
      totalBatches
    });

    try {
      const result = await googleTranslate(batchText);
      // Split back by separator (Google might slightly modify it)
      const parts = result.split(/🔹/);

      for (let j = 0; j < batch.length && j < parts.length; j++) {
        translated[i + j] = {
          ...blocks[i + j],
          text: parts[j].trim()
        };
      }
    } catch (err) {
      broadcastFn('log', { message: `⚠️ שגיאת תרגום באצווה ${batchCount}: ${err.message}` });
      // Keep original text on error
    }

    // Rate limit: small delay between batches
    if (i + BATCH_SIZE < blocks.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  return translated;
}

// Translation sessions
const translateSessions = new Map();

// Start translation
app.post('/api/translate', (req, res) => {
  const { showName } = req.body;
  if (!showName) return res.status(400).json({ error: 'Missing showName' });

  const showDir = path.join(DOWNLOADS_DIR, showName);
  if (!fs.existsSync(showDir)) return res.status(404).json({ error: 'Show not found' });

  // Find all .txt files with VTT content
  const txtFiles = [];
  function findTxtFiles(dir) {
    try {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          findTxtFiles(fullPath);
        } else if (path.extname(item).toLowerCase() === '.txt') {
          try {
            const head = fs.readFileSync(fullPath, 'utf8').substring(0, 50);
            if (head.includes('WEBVTT')) {
              // Check if .vtt already exists
              const vttPath = fullPath.replace(/\.txt$/i, '.vtt');
              txtFiles.push({
                txtPath: fullPath,
                vttPath,
                name: item,
                alreadyTranslated: fs.existsSync(vttPath),
                relativePath: path.relative(showDir, fullPath)
              });
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
  }
  findTxtFiles(showDir);

  const sessionId = uuidv4();
  const session = {
    id: sessionId, showName, files: txtFiles,
    status: 'pending', listeners: [], logs: []
  };
  translateSessions.set(sessionId, session);

  res.json({
    sessionId,
    totalFiles: txtFiles.length,
    alreadyTranslated: txtFiles.filter(f => f.alreadyTranslated).length,
    toTranslate: txtFiles.filter(f => !f.alreadyTranslated).length,
    files: txtFiles.map(f => ({ name: f.name, alreadyTranslated: f.alreadyTranslated, relativePath: f.relativePath }))
  });
});

// SSE for translation progress
app.get('/api/translate/progress/:id', (req, res) => {
  const session = translateSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Not found' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  sendSSE(res, 'init', {
    showName: session.showName,
    totalFiles: session.files.length,
    toTranslate: session.files.filter(f => !f.alreadyTranslated).length
  });
  for (const log of session.logs) sendSSE(res, log.event, log.data);

  session.listeners.push(res);
  req.on('close', () => { session.listeners = session.listeners.filter(l => l !== res); });

  if (session.status === 'pending') {
    session.status = 'running';
    runTranslation(session);
  }
});

function broadcastTranslate(session, event, data) {
  session.logs.push({ event, data });
  for (const l of session.listeners) sendSSE(l, event, data);
}

async function runTranslation(session) {
  const { files, showName } = session;
  const bc = (event, data) => broadcastTranslate(session, event, data);
  const toTranslate = files.filter(f => !f.alreadyTranslated);
  const startTime = Date.now();
  let translated = 0;

  bc('log', { message: `🌐 מתחיל תרגום עבור ${showName}` });
  bc('log', { message: `📋 ${files.length} קבצים, ${files.length - toTranslate.length} כבר תורגמו, ${toTranslate.length} לתרגום` });

  for (const file of files) {
    if (file.alreadyTranslated) {
      bc('file_status', { file: file.relativePath, status: 'exists' });
      bc('log', { message: `⏭️ ${file.name} — כבר תורגם` });
      continue;
    }

    bc('file_status', { file: file.relativePath, status: 'translating' });
    bc('log', { message: `\n━━━ ${file.name} ━━━` });
    const fileStart = Date.now();

    try {
      // Read and parse VTT
      const content = fs.readFileSync(file.txtPath, 'utf8');
      const blocks = parseVTT(content);
      bc('log', { message: `📝 ${blocks.length} בלוקי כתוביות` });

      // Translate
      const translatedBlocks = await translateSubtitleBlocks(blocks, bc);

      // Build VTT and save
      const vttContent = buildVTT(translatedBlocks);
      fs.writeFileSync(file.vttPath, vttContent, 'utf8');

      const fileDuration = Date.now() - fileStart;
      translated++;
      bc('file_status', { file: file.relativePath, status: 'complete' });
      bc('log', { message: `✅ ${file.name} → .vtt (${formatDuration(fileDuration)})` });
      bc('translate_batch_progress', {
        translated,
        total: toTranslate.length,
        elapsed: formatDuration(Date.now() - startTime)
      });
    } catch (err) {
      bc('file_status', { file: file.relativePath, status: 'error' });
      bc('log', { message: `❌ ${file.name}: ${err.message}` });
    }

    // Small delay between files
    await new Promise(r => setTimeout(r, 500));
  }

  const totalTime = Date.now() - startTime;
  session.status = 'complete';
  bc('translate_complete', {
    showName,
    translated,
    total: toTranslate.length,
    totalTime: formatDuration(totalTime)
  });
  bc('log', { message: `\n🎉 תרגום הושלם! ${translated} קבצים ב-${formatDuration(totalTime)}` });
}

// ─────────────────────────────────────────────

app.get('/api/check/:showName/:episode', (req, res) => {
  const exists = episodeExists(req.params.showName, parseInt(req.params.episode));
  res.json({ exists });
});

app.listen(PORT, () => {
  console.log(`\n🎬 NowTV Downloader running at http://localhost:${PORT}`);
  console.log(`📂 Downloads: ${DOWNLOADS_DIR}\n`);
});
