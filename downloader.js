/**
 * ============================================
 * All Media Downloader Bot - Downloader
 * ============================================
 * Developer : Md. Mainul Islam
 * Owner     : MAINUL - X
 * Telegram  : https://t.me/mdmainulislaminfo
 * GitHub    : https://github.com/M41NUL
 * WhatsApp  : +8801308850528
 * Channel   : https://t.me/mainul_x_official
 * Group     : https://t.me/mainul_x_official_gc
 * Email     : githubmainul@gmail.com | devmainulislam@gmail.com
 * YouTube   : https://youtube.com/@mdmainulislaminfo
 * License   : MIT License
 * ============================================
 *
 * This bot no longer runs yt-dlp or any scraper locally.
 * All video resolution is delegated to the All Media Downloader API:
 *   https://all-media-downloader-api.onrender.com
 *
 * Flow:
 *   1. Ask the API for video metadata + a direct video_url
 *   2. Stream that direct video_url down to a local temp file
 *   3. Return { filePath, title, size, duration, platform } to bot.js
 *      (same shape bot.js already expects — no changes needed there)
 */

'use strict';

const https      = require('https');
const http       = require('http');
const urlModule  = require('url');
const fs         = require('fs');
const path       = require('path');
const os         = require('os');
const { URL_PATTERNS, DOWNLOAD_TIMEOUT, API_BASE_URL, API_KEY } = require('./config');

// ══════════════════════════════════════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════════════════════════════════════

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB — Telegram bot limit
const API_TIMEOUT   = 60_000;           // 60s for the metadata call

// ══════════════════════════════════════════════════════════════════════════════
// PLATFORM DETECTION
// ══════════════════════════════════════════════════════════════════════════════

function detectPlatform(rawUrl) {
  if (URL_PATTERNS.tiktok.test(rawUrl))    return 'tiktok';
  if (URL_PATTERNS.instagram.test(rawUrl)) return 'instagram';
  if (URL_PATTERNS.facebook.test(rawUrl))  return 'facebook';
  return null;
}

// ══════════════════════════════════════════════════════════════════════════════
// API CALL — fetch metadata + direct video_url
// ══════════════════════════════════════════════════════════════════════════════

function fetchFromApi(videoUrl, platform) {
  return new Promise((resolve, reject) => {
    const endpointMap = {
      tiktok    : '/api/tiktok',
      instagram : '/api/instagram',
      facebook  : '/api/facebook',
    };
    const endpoint = endpointMap[platform] || '/api/download';

    const apiUrl = `${API_BASE_URL}${endpoint}?url=${encodeURIComponent(videoUrl)}`;
    const parsed = new urlModule.URL(apiUrl);
    const lib    = parsed.protocol === 'https:' ? https : http;

    const req = lib.request(
      {
        hostname : parsed.hostname,
        path     : parsed.pathname + parsed.search,
        method   : 'GET',
        headers  : {
          'x-api-key' : API_KEY,
          'Accept'    : 'application/json',
        },
        timeout  : API_TIMEOUT,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let parsedBody;
          try {
            parsedBody = JSON.parse(data);
          } catch {
            return reject(new Error(`API returned invalid response (HTTP ${res.statusCode})`));
          }

          if (res.statusCode !== 200 || !parsedBody.success) {
            const detail = parsedBody.detail || parsedBody.error || 'Unknown API error';
            return reject(new Error(detail));
          }

          resolve(parsedBody);
        });
      }
    );

    req.on('error',   (e) => reject(new Error(`Could not reach API: ${e.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('API request timed out')); });
    req.end();
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// STREAM DIRECT VIDEO URL TO LOCAL TEMP FILE
// ══════════════════════════════════════════════════════════════════════════════

function downloadToFile(videoUrl) {
  return new Promise((resolve, reject) => {
    const tmpDir  = os.tmpdir();
    const outFile = path.join(tmpDir, `dl_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);

    const doRequest = (currentUrl, redirectCount = 0) => {
      if (redirectCount > 5) return reject(new Error('Too many redirects'));

      let parsed;
      try { parsed = new urlModule.URL(currentUrl); }
      catch (e) { return reject(new Error('Invalid video URL: ' + currentUrl)); }

      const lib = parsed.protocol === 'https:' ? https : http;

      const req = lib.request(
        {
          hostname : parsed.hostname,
          path     : parsed.pathname + parsed.search,
          method   : 'GET',
          headers  : {
            'User-Agent'      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept'          : 'video/mp4,video/*,*/*',
            'Accept-Encoding' : 'identity',
            'Connection'      : 'keep-alive',
          },
          timeout  : DOWNLOAD_TIMEOUT,
        },
        (res) => {
          if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
            return doRequest(res.headers.location, redirectCount + 1);
          }
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode} while downloading video`));
          }

          const contentLength = parseInt(res.headers['content-length'] || '0', 10);
          if (contentLength > MAX_FILE_SIZE) {
            req.destroy();
            return reject(new Error(
              `Video is too large (${(contentLength / 1024 / 1024).toFixed(1)} MB). ` +
              `Maximum allowed size is ${MAX_FILE_SIZE / 1024 / 1024} MB.`
            ));
          }

          const fileStream = fs.createWriteStream(outFile);
          let   received   = 0;
          let   aborted    = false;

          res.on('data', (chunk) => {
            received += chunk.length;
            if (received > MAX_FILE_SIZE && !aborted) {
              aborted = true;
              req.destroy();
              fileStream.destroy();
              fs.unlink(outFile, () => {});
              reject(new Error(
                `Video exceeded ${MAX_FILE_SIZE / 1024 / 1024} MB limit during download.`
              ));
            }
          });

          res.pipe(fileStream);

          fileStream.on('finish', () => {
            if (!aborted) resolve(outFile);
          });
          fileStream.on('error', (e) => {
            fs.unlink(outFile, () => {});
            reject(e);
          });
          res.on('error', (e) => {
            fs.unlink(outFile, () => {});
            reject(e);
          });
        }
      );

      req.on('error',   (e) => { fs.unlink(outFile, () => {}); reject(e); });
      req.on('timeout', ()  => { req.destroy(); reject(new Error('Download timeout')); });
      req.end();
    };

    doRequest(videoUrl);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// CLEANUP
// ══════════════════════════════════════════════════════════════════════════════

function cleanupFile(filePath) {
  if (filePath) {
    try { fs.unlinkSync(filePath); } catch (_) {}
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN DISPATCHER
// ══════════════════════════════════════════════════════════════════════════════

async function download(videoUrl, forcePlatform = null) {
  const platform = forcePlatform || detectPlatform(videoUrl);
  if (!platform) throw new Error('Unsupported URL. Send a valid TikTok, Instagram, or Facebook link.');

  const apiResult = await fetchFromApi(videoUrl, platform);

  if (!apiResult.video_url) {
    throw new Error('API did not return a downloadable video URL.');
  }

  const filePath = await downloadToFile(apiResult.video_url);

  return {
    filePath,
    title    : apiResult.caption || `${platform[0].toUpperCase()}${platform.slice(1)} Video`,
    size     : apiResult.size     || 'Unknown',
    duration : apiResult.duration || 'Unknown',
    platform : platform[0].toUpperCase() + platform.slice(1),
  };
}

module.exports = { download, detectPlatform, cleanupFile };
