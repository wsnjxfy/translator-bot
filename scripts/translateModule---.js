/**
 * ===== 强制当前脚本不使用系统代理 / VPN =====
 */
process.env.HTTP_PROXY = '';
process.env.HTTPS_PROXY = '';
process.env.ALL_PROXY = '';
process.env.http_proxy = '';
process.env.https_proxy = '';
process.env.all_proxy = '';

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = path.resolve(__dirname, '../output');
const USER_DATA_DIR = path.resolve(__dirname, '../user-data-deepseek');
const MAX_WAIT_TIME = 120000; // 2分钟

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForCompleteTranslation(page, lastCount) {
  const answerSelector = 'div[class*="messageContent"], div[class*="markdown"], div[class*="message-text"]';
  const start = Date.now();
  let stableStart = Date.now();
  let previousLength = lastCount;

  while (Date.now() - start < MAX_WAIT_TIME) {
    const messages = await page.$$eval(answerSelector, nodes =>
      nodes.map(n => n.innerText.trim()).filter(Boolean)
    );
    const newMessages = messages.slice(lastCount);

    if (messages.length > previousLength) {
      stableStart = Date.now();
      previousLength = messages.length;
    } else if (Date.now() - stableStart > 2000 && newMessages.length > 0) {
      return newMessages.join(' ');
    }

    await delay(500);
  }

  throw new Error('等待翻译超时');
}

function loadCache(filePath) {
  const OUTPUT_FILE = path.resolve(
    OUTPUT_DIR,
    path.basename(filePath, '.txt') + '.json'
  );

  if (!fs.existsSync(OUTPUT_FILE)) return {};

  try {
    return JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveCache(filePath, cache) {
  const OUTPUT_FILE = path.resolve(
    OUTPUT_DIR,
    path.basename(filePath, '.txt') + '.json'
  );

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(cache, null, 2), 'utf-8');
}

// ====== 短句合并：<= 10 个单词的句子会并入下一句 ======
function mergeShortSentences(text) {
  const sentences = text.split(/(?<=[。！？.!?])\s*/).filter(Boolean);
  const merged = [];
  let buffer = '';

  for (const s of sentences) {
    const wordCount = s.trim().split(/\s+/).length;
    if (wordCount <= 10) {
      buffer += s + ' ';
    } else {
      if (buffer) {
        merged.push((buffer + s).trim());
        buffer = '';
      } else {
        merged.push(s.trim());
      }
    }
  }

  if (buffer) merged.push(buffer.trim());
  return merged;
}

// ===== 核心函数：翻译单个文章 =====
async function translateArticle(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error('文章不存在: ' + filePath);
  }

  const text = fs.readFileSync(filePath, 'utf-8');
  const sentences = mergeShortSentences(text);
  const cache = loadCache(filePath);

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    userDataDir: USER_DATA_DIR,
    executablePath: puppeteer.executablePath(),
    args: [
      '--no-sandbox',
      '--proxy-server=direct://',
      '--proxy-bypass-list=*',
      '--disable-blink-features=AutomationControlled'
    ],
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/117.0.0.0 Safari/537.36'
  );

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  console.log('正在打开 DeepSeek Chat 页面...');
  await page.goto('https://chat.deepseek.com', { waitUntil: 'networkidle2', timeout: 0 });
  console.log('DeepSeek Chat 页面已打开');

  if (!fs.existsSync(USER_DATA_DIR) || fs.readdirSync(USER_DATA_DIR).length === 0) {
    console.log('第一次运行，请手动登录 DeepSeek Chat 页面');
    console.log('登录完成后，在浏览器中点击一次输入框，然后按回车继续...');
    await new Promise(resolve => process.stdin.once('data', () => resolve()));
  } else {
    console.log('使用已保存的登录状态，跳过手动登录');
  }

  const answerSelector = 'div[class*="messageContent"], div[class*="markdown"], div[class*="message-text"]';
  let messages = await page.$$eval(answerSelector, nodes => nodes.map(n => n.innerText.trim()));
  let lastCount = messages.length;

  let allSuccess = true; // 默认整篇文章成功

  for (const sentence of sentences) {
    if (cache[sentence]) continue;

    console.log('正在翻译:', sentence);

    try {
      // 聚焦输入框
      await page.evaluate(() => {
        const textarea = document.querySelector('textarea') || document.querySelector('[contenteditable="true"]');
        if (!textarea) throw new Error('未找到 DeepSeek 输入框');
        textarea.focus();
      });

      // 写入剪贴板并粘贴
      const prompt = '请将下面英文翻译成中文：\n';
      const fullPrompt = prompt + sentence;
      await page.evaluate(async (text) => {
        await navigator.clipboard.writeText(text);
      }, fullPrompt);

      // 粘贴 + 回车发送
      await page.keyboard.down('Control'); // macOS 请改 'Meta'
      await page.keyboard.press('V');
      await page.keyboard.up('Control');
      await page.keyboard.press('Enter');

      // 等待翻译结果
      const translation = await waitForCompleteTranslation(page, lastCount);
      console.log('翻译结果:', translation);

      cache[sentence] = {
        translation,
        engine: 'deepseek',
        createdAt: new Date().toISOString(),
      };
      saveCache(filePath, cache);

      messages = await page.$$eval(answerSelector, nodes => nodes.map(n => n.innerText.trim()));
      lastCount = messages.length;

      await delay(1000);

    } catch (err) {
      console.error('翻译出错，跳过:', sentence, err);
      allSuccess = false; // 只要有一次失败，整篇标记 false
    }
  }

  console.log(`✅ ${path.basename(filePath)} 翻译完成`);

  process.stdout.write('\x07');
  await browser.close();

  return { allSuccess };
}

module.exports = { translateArticle };
