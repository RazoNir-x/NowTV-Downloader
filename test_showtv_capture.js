const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');

  cdp.on('Network.requestWillBeSent', (params) => {
    const reqUrl = params.request.url;
    if (reqUrl.includes('.m3u8') || reqUrl.includes('.mp4') || reqUrl.includes('manifest') || reqUrl.includes('playlist')) {
      console.log('MEDIA REQUEST:', reqUrl);
    }
  });

  console.log('Navigating to ShowTV episode 123...');
  await page.goto('https://www.showtv.com.tr/dizi/tum_bolumler/kizilcik-serbeti-sezon-4-bolum-123-izle/130327', { waitUntil: 'domcontentloaded', timeout: 35000 });

  console.log('Waiting 5s...');
  await new Promise(r => setTimeout(r, 5000));

  console.log('Looking for play buttons or iframe...');
  const iframes = await page.$$('iframe');
  console.log('Found iframes count:', iframes.length);
  for (const f of iframes) {
    const src = await page.evaluate(el => el.src, f);
    console.log('Iframe src:', src);
  }

  console.log('Clicking play buttons...');
  await page.evaluate(() => {
    const v = document.querySelector('video');
    if (v) { v.muted = true; v.play().catch(() => {}); }
  });

  const playSelectors = [
    '#foxPlayer .vjs-big-play-button', '.vjs-big-play-button', '.video-js .vjs-big-play-button',
    '.video-player .vjs-big-play-button', '.vod-player .vjs-big-play-button', '#foxPlayer',
    '.play-button', 'button[aria-label*="play"]', 'button[aria-label*="Play"]', 'button[aria-label*="Oynat"]',
    '#video-player', '.video-box', '#player', '.player-container'
  ];

  for (const s of playSelectors) {
    try {
      const el = await page.$(s);
      if (el) {
        console.log('Found selector:', s);
        await el.click();
      }
    } catch (e) {}
  }

  console.log('Waiting 10s for media network requests...');
  await new Promise(r => setTimeout(r, 10000));

  await browser.close();
})();
