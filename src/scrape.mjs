import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const outDir = path.resolve('result');
fs.mkdirSync(outDir, { recursive: true });

function fail(message, details = '') {
  const text = `## ❌ Ozon 抓取失败\n\n${message}${details ? `\n\n\`\`\`text\n${details}\n\`\`\`` : ''}`;
  fs.writeFileSync(path.join(outDir, 'comment.md'), text, 'utf8');
  fs.writeFileSync(path.join(outDir, 'error.txt'), `${message}\n${details}`, 'utf8');
  process.exitCode = 1;
}

function extractOzonUrl(text) {
  const match = String(text || '').match(/https?:\/\/(?:www\.)?ozon\.(?:ru|com)\/[^\s<>"')]+/i);
  return match ? match[0].replace(/[.,;!?]+$/, '') : null;
}

function decodeEscapedUrl(value) {
  return String(value || '')
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .trim();
}

function normalizeUrl(value) {
  try {
    const decoded = decodeEscapedUrl(value);
    if (!/^https?:\/\//i.test(decoded)) return null;
    const u = new URL(decoded);
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

function imageScore(url) {
  const u = url.toLowerCase();
  let score = 0;
  if (u.includes('multimedia')) score += 40;
  if (u.includes('ir.ozone.ru')) score += 35;
  if (/\.(?:jpe?g|png|webp|avif)(?:\?|$)/i.test(u)) score += 20;
  if (/(?:wc|wh|w|h)(?:800|900|1000|1200|1500|2000)/i.test(u)) score += 18;
  if (/(?:wc|wh|w|h)(?:50|80|100|120|150|200)/i.test(u)) score -= 18;
  if (/(icon|logo|avatar|sprite|favicon|badge|flag|star|payment|delivery)/i.test(u)) score -= 35;
  return score;
}

function isLikelyImageUrl(url) {
  const u = url.toLowerCase();
  if (!u.startsWith('http')) return false;
  const isOzonCdn = u.includes('ozone.ru') || u.includes('ozon.ru');
  const hasImageExt = /\.(?:jpe?g|png|webp|avif)(?:\?|$)/i.test(u);
  return isOzonCdn && (hasImageExt || u.includes('multimedia'));
}

async function main() {
  const token = process.env.BROWSERLESS_TOKEN?.trim();
  if (!token) {
    fail('仓库还没有配置 `BROWSERLESS_TOKEN`。请先按 README 的一次性设置完成。');
    return;
  }

  const sourceText = `${process.env.ISSUE_TITLE || ''}\n${process.env.ISSUE_BODY || ''}`;
  const targetUrl = extractOzonUrl(sourceText);
  if (!targetUrl) {
    fail('Issue 中没有识别到完整的 Ozon 商品链接。');
    return;
  }

  const launch = encodeURIComponent(JSON.stringify({
    headless: true,
    stealth: true,
    args: ['--window-size=1440,1200', '--lang=ru-RU']
  }));

  const wsEndpoint =
    `wss://production-ams.browserless.io?token=${encodeURIComponent(token)}` +
    `&timeout=60000&stealth=true&proxy=datacenter&proxyCountry=de` +
    `&proxyLocaleMatch=true&launch=${launch}`;

  let browser;
  try {
    browser = await chromium.connectOverCDP(wsEndpoint, { timeout: 25000 });
    const context = browser.contexts()[0] || await browser.newContext({
      locale: 'ru-RU',
      viewport: { width: 1440, height: 1200 }
    });
    const page = context.pages()[0] || await context.newPage();

    await page.setExtraHTTPHeaders({
      'accept-language': 'ru-RU,ru;q=0.9,en;q=0.7'
    });

    const networkUrls = new Set();
    page.on('response', response => {
      const url = normalizeUrl(response.url());
      const type = (response.headers()['content-type'] || '').toLowerCase();
      if (url && (type.startsWith('image/') || isLikelyImageUrl(url))) {
        networkUrls.add(url);
      }
    });

    await page.route('**/*', async route => {
      const type = route.request().resourceType();
      if (type === 'font' || type === 'media') {
        await route.abort();
      } else {
        await route.continue();
      }
    });

    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 45000
    });

    await page.waitForTimeout(3500);

    for (let i = 0; i < 10; i += 1) {
      await page.mouse.wheel(0, 850);
      await page.waitForTimeout(450);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(700);

    const thumbnailSelectors = [
      '[data-widget*="Gallery"] img',
      '[data-widget*="gallery"] img',
      '[class*="thumb"] img',
      '[class*="Thumb"] img'
    ];

    for (const selector of thumbnailSelectors) {
      const locator = page.locator(selector);
      const count = Math.min(await locator.count(), 30);
      for (let i = 0; i < count; i += 1) {
        try {
          const item = locator.nth(i);
          const box = await item.boundingBox();
          if (box && box.width >= 28 && box.height >= 28) {
            await item.click({ timeout: 500 });
            await page.waitForTimeout(180);
          }
        } catch {
          // 某些缩略图不可点击，不影响后续 DOM/JSON 抽取。
        }
      }
    }

    const domData = await page.evaluate(() => {
      const urls = new Set();
      const add = value => {
        if (!value || typeof value !== 'string') return;
        for (const item of value.split(',')) {
          const candidate = item.trim().split(/\s+/)[0];
          if (/^https?:\/\//i.test(candidate)) urls.add(candidate);
        }
      };

      document.querySelectorAll('img').forEach(img => {
        add(img.src);
        add(img.currentSrc);
        add(img.getAttribute('src'));
        add(img.getAttribute('srcset'));
        add(img.getAttribute('data-src'));
        add(img.getAttribute('data-original'));
      });

      document.querySelectorAll('source').forEach(source => {
        add(source.getAttribute('src'));
        add(source.getAttribute('srcset'));
      });

      document.querySelectorAll('*').forEach(el => {
        const bg = getComputedStyle(el).backgroundImage;
        if (!bg || bg === 'none') return;
        for (const match of bg.matchAll(/url\(["']?(.*?)["']?\)/g)) add(match[1]);
      });

      const scriptText = [...document.scripts]
        .map(script => script.textContent || '')
        .join('\n');

      const title =
        document.querySelector('h1')?.textContent?.trim() ||
        document.title || '';

      const bodyText = document.body?.innerText || '';
      const priceMatches = bodyText.match(/\b[\d\s]{2,9}\s?₽/g) || [];

      return {
        urls: [...urls],
        scriptText,
        title,
        prices: [...new Set(priceMatches)].slice(0, 12),
        finalUrl: location.href
      };
    });

    const scriptUrls = [];
    const urlRegex = /https?:\\?\/\\?\/[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+/g;
    for (const match of domData.scriptText.matchAll(urlRegex)) {
      scriptUrls.push(match[0]);
    }

    const all = new Set([...networkUrls, ...domData.urls, ...scriptUrls]);
    const images = [...all]
      .map(normalizeUrl)
      .filter(Boolean)
      .filter(isLikelyImageUrl)
      .sort((a, b) => imageScore(b) - imageScore(a));

    const deduped = [];
    const seen = new Set();
    for (const url of images) {
      const key = url
        .replace(/([?&])(width|height|w|h|quality|format)=[^&]*/gi, '$1')
        .replace(/[?&]+$/, '');
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(url);
      if (deduped.length >= 80) break;
    }

    const manifest = {
      sourceUrl: targetUrl,
      finalUrl: domData.finalUrl,
      title: domData.title,
      prices: domData.prices,
      imageCount: deduped.length,
      images: deduped,
      collectedAt: new Date().toISOString()
    };

    fs.writeFileSync(
      path.join(outDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf8'
    );

    await page.screenshot({
      path: path.join(outDir, 'page.png'),
      fullPage: false
    });

    const preview = deduped.slice(0, 24)
      .map((url, index) => `${index + 1}. ${url}`)
      .join('\n');

    const comment = [
      '## ✅ Lemon Image Factory 已完成抓取',
      '',
      `**商品：** ${domData.title || '未识别标题'}`,
      '',
      `**价格线索：** ${domData.prices.join(' / ') || '未识别'}`,
      '',
      `**图片候选：** ${deduped.length} 张`,
      '',
      '<details>',
      '<summary>展开图片 URL</summary>',
      '',
      preview || '没有提取到图片 URL。',
      '',
      '</details>',
      '',
      '完整清单和页面截图已保存为本次工作流 Artifact。'
    ].join('\n');

    fs.writeFileSync(path.join(outDir, 'comment.md'), comment, 'utf8');
    await browser.close();
  } catch (error) {
    try { await browser?.close(); } catch {}
    fail('Browserless 已连接，但 Ozon 页面抓取没有成功。', error?.stack || String(error));
  }
}

await main();
