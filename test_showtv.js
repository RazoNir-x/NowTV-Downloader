const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-web-security'] });
  const page = await browser.newPage();
  
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');

  cdp.on('Network.requestWillBeSent', (params) => {
    const reqUrl = params.request.url;
    if (reqUrl.includes('.m3u8') || reqUrl.includes('.vtt')) {
      console.log('FOUND:', reqUrl);
    }
  });

  console.log('Navigating...');
  await page.goto('https://www.showtv.com.tr/dizi/tum_bolumler/kizilcik-serbeti-sezon-4-bolum-104-izle/127525', { waitUntil: 'networkidle2' });
  
  console.log('Trying to play video...');
  await page.evaluate(() => { const v = document.querySelector('video'); if (v) { v.muted = true; v.play().catch(() => {}); } });
  
  // click any big play button
  const sel = ['.vjs-big-play-button', 'button[title="Play Video"]', 'button.video-js'];
  for (const s of sel) {
    try { await page.click(s); console.log('Clicked', s); break; } catch (e) {}
  }
  
  await new Promise(r => setTimeout(r, 10000));
  await browser.close();
  console.log('Done.');
})();
