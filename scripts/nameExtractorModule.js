// scripts/nameExtractorModule.js

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

const USER_DATA_DIR = path.resolve(__dirname, '../user-data-deepseek');
const NAME_OUTPUT_DIR = path.resolve(__dirname, '../output/names');
const MAX_WAIT_TIME = 120000;

/* ---------------- 工具函数 ---------------- */

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeName(name) {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * 从文本中“保险”抽取 JSON 数组
 */
function safeExtractJsonArray(text) {
  if (!text) return null;

  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
  } catch {}

  const match = cleaned.match(/\[[\s\S]*?\]/);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[0]);
    if (Array.isArray(parsed)) return parsed;
  } catch {}

  return null;
}

/**
 * 等待 DeepSeek 返回最终回答
 */
async function waitForFinalAnswer(page, lastCount) {
  const selector =
    'div[class*="messageContent"], div[class*="markdown"], div[class*="message-text"]';

  const start = Date.now();
  let stableStart = Date.now();
  let prevLen = lastCount;

  while (Date.now() - start < MAX_WAIT_TIME) {
    const messages = await page.$$eval(selector, nodes =>
      nodes.map(n => n.innerText.trim()).filter(Boolean)
    );

    if (messages.length > prevLen) {
      prevLen = messages.length;
      stableStart = Date.now();
    } else if (Date.now() - stableStart > 2500) {
      return messages[messages.length - 1];
    }

    await delay(500);
  }

  throw new Error('等待 DeepSeek 人名提取结果超时');
}

/* ---------------- 核心函数 ---------------- */

async function extractNamesFromArticle(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error('文章不存在: ' + filePath);
  }

  const text = fs.readFileSync(filePath, 'utf-8');
  const fileName = path.basename(filePath);

  if (!fs.existsSync(NAME_OUTPUT_DIR)) {
    fs.mkdirSync(NAME_OUTPUT_DIR, { recursive: true });
  }

  const outputFile = path.resolve(
    NAME_OUTPUT_DIR,
    fileName.replace(/\.txt$/i, '.names.json')
  );

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

  console.log(`🔍 正在提取人名: ${fileName}`);

  await page.goto('https://chat.deepseek.com', {
    waitUntil: 'networkidle2',
    timeout: 0,
  });

  const selector =
    'div[class*="messageContent"], div[class*="markdown"], div[class*="message-text"]';

  const messages = await page.$$eval(selector, nodes =>
    nodes.map(n => n.innerText.trim())
  );
  let lastCount = messages.length;

  /* ===== 一次性 Prompt ===== */
  const prompt = `
你是一个严格的文本信息抽取工具。

任务：
从下面的英文文章中，提取【作为人物姓名出现的罗马音英文名】。

严格规则：
1. 仅限人物姓名
2. 不包含游戏ID、昵称、队伍名、职位、称号
3. 不要解释、不要翻译、不要注释
4. 去重
5. 只输出 JSON 数组

正确示例：
[
  "Jeong Ji-hoon",
  "Lee Sang-hyeok"
]

文章正文开始：
${text}
文章正文结束。
`.trim();

  /* ===== 核心：直接注入输入框 ===== */
  await page.evaluate((content) => {
    const textarea =
      document.querySelector('textarea') ||
      document.querySelector('[contenteditable="true"]');

    if (!textarea) {
      throw new Error('未找到 DeepSeek 输入框');
    }

    textarea.focus();

    if (textarea.tagName.toLowerCase() === 'textarea' || textarea.tagName.toLowerCase() === 'input') {
      textarea.value = content;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      textarea.innerText = content;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, prompt);

  await delay(300);

  /* ===== 使用 Enter 发送 ===== */
  await page.keyboard.press('Enter');

  const rawResult = await waitForFinalAnswer(page, lastCount);

  const nameList = safeExtractJsonArray(rawResult);
  if (!nameList) {
    throw new Error(
      '❌ 无法从 DeepSeek 输出中解析出合法 JSON 数组:\n' + rawResult
    );
  }

  const formatted = {
    file: fileName,
    extractedAt: new Date().toISOString(),
    count: nameList.length,
    names: nameList.map(n => ({
      raw: n,
      normalized: normalizeName(n),
    })),
  };

  fs.writeFileSync(outputFile, JSON.stringify(formatted, null, 2), 'utf-8');

  console.log(`✅ 人名提取完成，共 ${formatted.count} 个`);
  console.log(`📁 输出文件: ${outputFile}`);

  await browser.close();
  return formatted;
}

module.exports = { extractNamesFromArticle };
