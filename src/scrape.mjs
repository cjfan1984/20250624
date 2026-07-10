import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const outDir = path.resolve('result');
fs.mkdirSync(outDir, { recursive: true });

function writeFailure(message, details = '') {
  const text = `## ❌ Ozon 抓取失败\n\n${message}${details ? `\n\n\`\`\`text\n${details}\n\`\`\`` : ''}`;
  fs.writeFileSync(path.join(outDir, 'comment.md'), text, 'utf8');
  fs.writeFileSync(path.join(outDir, 'error.txt'), `${message}\n${details}`, 'utf8');
  process.exitCode = 1;
}

function extractOzonUrl(text) {
  const match = String(text || '').match(/https?:\/\/(?:www\.)?ozon\.(?:ru|com)\/[^\s<>"')]+/i);
  return match ? match[0].replace(/[.,;!?]+$/, '') : null;
}

function normalizeUrl(value) {
  try {
    const decoded = String(value || '')
      .replace(/\\u002F/gi, '/')
      .replace(/\\\//g, '/')
      .replace(/&amp;/g, '&')
      .trim();
    if (!/^https?:\/\//i.test(decoded)) return null;
    const u = new URL(decoded);
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

function likelyImage(url) {
  const u = String(url || '').toLowerCase();
  if (!u.startsWith('http')) return false;
  if (!(u.includes('ozone.ru') || u.includes('ozon.ru'))) return false;
  if (/(warn\.png|icon|logo|avatar|sprite|favicon|badge|flag|star)/i.test(u)) return false;
  return /\.(?:jpe?g|png|webp|avif)(?:\?|$)/i.test(u) || u.includes('multimedia');
}

function score(url) {
  const u = url.toLowerCase();
  let n = 0;
  if (u.includes('multimedia')) n += 50;
  if (u.includes('ir.ozone.ru')) n += 35;
  if (/(?:wc|wh|w|h)(?:800|900|1000|1200|1500|2000)/i.test(u)) n += 20;
  if (/(?:wc|wh|w|h)(?:50|80|100|120|150|200)/i.test(u)) n -= 20;
  return n;
}

function blockedPage(title, body) {
  const text = `${title}\n${body}`.toLowerCase();
  return [
    'похоже, нет соединения',
    'нет соединения',
    'access denied',
    'captcha',
    'robot or human',
    'abt-challenge',
    'проверяем, что вы не робот'
  ].some(x => text.includes(x));
}

async function collectWithEndpoint(endpoint, token, targetUrl, attemptNo) {
  const ws = `wss://${endpoint}?token=${encodeURIComponent(token)}&timeout=60000`;
  let browser;
  try {
    browser = await chromium.connectOverCDP(ws, { timeout: 25000 });
    const context = browser.contexts()[0] || await browser.newContext({
      locale: 'ru-RU',
      viewport: { width: 1440, height: 1200 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    });
    const page = context.pages()[0] || await context.newPage();
    await page.setExtraHTTPHeaders({
      'accept-language': 'ru-RU,ru;q=0.9,en-US;q=0.7,en;q=0.6'
    });

    const network = new Set();
    page.on('response', response => {
      const u = normalizeUrl(response.url());
      const type = (response.headers()['content-type'] || '').toLowerCase();
      if (u && (type.startsWith('image/') || likelyImage(u))) network.add(u);
    });

    await page.route('**/*', async route => {
      const type = route.request().resourceType();
      if (type === 'font' || type === 'media') await route.abort();
      else await route.continue();
    });

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000);

    const firstState = await page.evaluate(() => ({
      title: document.querySelector('h1')?.textContent?.trim() || document.title || '',
      body: (document.body?.innerText || '').slice(0, 5000),
      finalUrl: location.href
    }));

    await page.screenshot({
      path: path.join(outDir, `attempt-${attemptNo}-${endpoint}.png`),
      fullPage: false
    });

    if (blockedPage(firstState.title, firstState.body)) {
      await browser.close();
      return { ok: false, endpoint, reason: `blocked: ${firstState.title}` };
    }

    for (let i = 0; i < 12; i += 1) {
      await page.mouse.wheel(0, 850);
      await page.waitForTimeout(400);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(800);

    const data = await page.evaluate(() => {
      const urls = new Set();
      const add = value => {
        if (!value || typeof value !== 'string') return;
        for (const part of value.split(',')) {
          const candidate = part.trim().split(/\s+/)[0];
          if (/^https?:\/\//i.test(candidate)) urls.add(candidate);
        }
      };
      document.querySelectorAll('img').forEach(img => {
        add(img.src); add(img.currentSrc); add(img.getAttribute('src'));
        add(img.getAttribute('srcset')); add(img.getAttribute('data-src'));
        add(img.getAttribute('data-original'));
      });
      document.querySelectorAll('source').forEach(el => {
        add(el.getAttribute('src')); add(el.getAttribute('srcset'));
      });
      document.querySelectorAll('*').forEach(el => {
        const bg = getComputedStyle(el).backgroundImage;
        if (!bg || bg === 'none') return;
        for (const m of bg.matchAll(/url\(["']?(.*?)["']?\)/g)) add(m[1]);
      });
      const body = document.body?.innerText || '';
      return {
        urls: [...urls],
        scripts: [...document.scripts].map(s => s.textContent || '').join('\n'),
        title: document.querySelector('h1')?.textContent?.trim() || document.title || '',
        prices: [...new Set(body.match(/\b[\d\s]{2,9}\s?₽/g) || [])].slice(0, 12),
        finalUrl: location.href,
        bodyPreview: body.slice(0, 10000)
      };
    });

    const scriptUrls = [...data.scripts.matchAll(/https?:\\?\/\\?\/[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+/g)]
      .map(m => m[0]);
    const images = [...new Set([...network, ...data.urls, ...scriptUrls]
      .map(normalizeUrl)
      .filter(Boolean)
      .filter(likelyImage))]
      .sort((a, b) => score(b) - score(a))
      .slice(0, 100);

    if (images.length < 2) {
      await browser.close();
      return { ok: false, endpoint, reason: `only ${images.length} useful image(s)` };
    }

    const manifest = {
      sourceUrl: targetUrl,
      finalUrl: data.finalUrl,
      endpoint,
      title: data.title,
      prices: data.prices,
      imageCount: images.length,
      images,
      collectedAt: new Date().toISOString()
    };
    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    fs.writeFileSync(path.join(outDir, 'page-text.txt'), data.bodyPreview, 'utf8');
    await page.screenshot({ path: path.join(outDir, 'page.png'), fullPage: false });

    const preview = images.slice(0, 30).map((u, i) => `${i + 1}. ${u}`).join('\n');
    fs.writeFileSync(path.join(outDir, 'comment.md'), [
      '## ✅ Lemon Image Factory 已完成抓取', '',
      `**商品：** ${data.title || '未识别标题'}`, '',
      `**价格线索：** ${data.prices.join(' / ') || '未识别'}`, '',
      `**图片候选：** ${images.length} 张`, '',
      '<details>', '<summary>展开图片 URL</summary>', '', preview, '', '</details>', '',
      `成功节点：${endpoint}`, '',
      '完整清单、页面文本和截图已保存为本次工作流 Artifact。'
    ].join('\n'), 'utf8');

    await browser.close();
    return { ok: true, endpoint, images: images.length };
  } catch (error) {
    try { await browser?.close(); } catch {}
    return { ok: false, endpoint, reason: error?.message || String(error) };
  }
}

async function main() {
  const token = process.env.BROWSERLESS_TOKEN?.trim();
  if (!token) return writeFailure('仓库没有读取到 `BROWSERLESS_TOKEN`。');

  const source = `${process.env.ISSUE_TITLE || ''}\n${process.env.ISSUE_BODY || ''}`;
  const targetUrl = extractOzonUrl(source);
  if (!targetUrl) return writeFailure('Issue 中没有识别到完整的 Ozon 商品链接。');

  // 免费方案不使用付费住宅代理，依次尝试 Browserless 公共区域节点。
  const endpoints = [
    'production-sfo.browserless.io',
    'production-lon.browserless.io',
    'production-ams.browserless.io'
  ];
  const attempts = [];
  for (let i = 0; i < endpoints.length; i += 1) {
    const result = await collectWithEndpoint(endpoints[i], token, targetUrl, i + 1);
    attempts.push(result);
    if (result.ok) return;
  }

  writeFailure(
    '三个免费 Browserless 区域节点都未能取得有效 Ozon 商品页。',
    attempts.map(a => `${a.endpoint}: ${a.reason}`).join('\n')
  );
}

await main();
