const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

  // Intercept and block ads
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    if (
      url.includes('doubleclick.net') ||
      url.includes('googleads') ||
      url.includes('2mdn.net') ||
      url.includes('googlesyndication') ||
      url.includes('securepubads') ||
      url.includes('taboola') ||
      url.includes('outbrain') ||
      url.includes('/video_ads/') ||
      url.includes('web_video_ads')
    ) {
      req.abort();
    } else {
      req.continue();
    }
  });

  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');

  cdp.on('Network.requestWillBeSent', (params) => {
    const reqUrl = params.request.url;
    if (reqUrl.includes('.m3u8')) {
      console.log('EPISODE M3U8 STREAM FOUND:', reqUrl);
    }
  });

  console.log('Navigating with AdBlock enabled...');
  await page.goto('https://www.showtv.com.tr/dizi/tum_bolumler/kizilcik-serbeti-sezon-4-bolum-123-izle/130327', { waitUntil: 'domcontentloaded', timeout: 35000 });

  await new Promise(r => setTimeout(r, 2000));

  console.log('Clicking play buttons...');
  await page.evaluate(() => {
    const v = document.querySelector('video');
    if (v) { v.muted = true; v.play().catch(() => {}); }
  });

  const playSelectors = [
    '#foxPlayer .vjs-big-play-button', '.vjs-big-play-button', '.video-js .vjs-big-play-button',
    '.video-player .vjs-big-play-button', '.vod-player .vjs-big-play-button', '#foxPlayer',
    '.play-button', 'button[aria-label*="play"]', 'button[aria-label*="Play"]', 'button[aria-label*="Oynat"]'
  ];

  for (const s of playSelectors) {
    try {
      const el = await page.$(s);
      if (el) {
        console.log('Clicked:', s);
        await el.click();
      }
    } catch (e) {}
  }

  await new Promise(r => setTimeout(r, 8000));
  await browser.close();
})();
