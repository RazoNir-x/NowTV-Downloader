const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  console.log('Navigating with domcontentloaded...');
  try {
    await page.goto('https://www.showtv.com.tr/dizi/tum_bolumler/kizilcik-serbeti-sezon-4-bolum-123-izle/130327', { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log('Navigated successfully!');
  } catch (e) {
    console.log('Navigation error/timeout:', e.message);
  }

  const episodes = await page.evaluate(() => {
    const links = document.querySelectorAll('li.iterate a, a[href*="-bolum-"]');
    const results = {};
    for (const a of links) {
      const href = a.href;
      const titleEl = a.querySelector('[data-ajax-title]') || a.querySelector('.title') || a.querySelector('h3');
      const title = titleEl ? titleEl.textContent : (a.title || a.innerText || '');
      let epNum = null;
      
      const m1 = title.match(/(\d+)\.\s*Bölüm/i);
      if (m1) epNum = parseInt(m1[1]);
      else {
        const m2 = href.match(/-bolum-(\d+)/i);
        if (m2) epNum = parseInt(m2[1]);
      }
      if (epNum && href) results[epNum] = href;
    }
    return results;
  });

  console.log('Found episodes count:', Object.keys(episodes).length);
  console.log('Episodes 123 & 124:', episodes[123], episodes[124]);

  await browser.close();
})();
