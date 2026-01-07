// scripts/nameExtractorModule.js

/**
 * ===== 强制当前脚本不使用系统代理 / VPN =====
 */
// 清空各种环境变量，避免 Puppeteer 使用系统代理或 VPN
process.env.HTTP_PROXY = '';  
process.env.HTTPS_PROXY = '';
process.env.ALL_PROXY = '';
process.env.http_proxy = '';
process.env.https_proxy = '';
process.env.all_proxy = '';

// 引入 Puppeteer，用于自动化操作浏览器
const puppeteer = require('puppeteer');
// 引入 fs 模块，用于读写文件
const fs = require('fs');
// 引入 path 模块，用于处理路径
const path = require('path');

// 定义用户数据目录，保存浏览器状态等
const USER_DATA_DIR = path.resolve(__dirname, '../user-data-deepseek');
// 定义提取结果输出目录
const NAME_OUTPUT_DIR = path.resolve(__dirname, '../output/names');
// 定义等待 DeepSeek 最终回答的最长时间（毫秒）
const MAX_WAIT_TIME = 120000;

/* ---------------- 工具函数 ---------------- */

// 延时函数，返回一个 Promise，用于等待指定毫秒
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 标准化名字：全部小写，多个空格合并为一个，去除首尾空格
function normalizeName(name) {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * 从文本中“保险”抽取 JSON 数组
 * 先尝试直接解析 JSON，再用正则匹配数组
 */
function safeExtractJsonArray(text) {
  if (!text) return null; // 文本为空时返回 null

  // 去掉 ```json 和 ``` 包裹，清理文本
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();

  try {
    const parsed = JSON.parse(cleaned); // 尝试直接解析
    if (Array.isArray(parsed)) return parsed; // 解析成功且是数组就返回
  } catch {} // 解析失败就忽略

  // 使用正则匹配文本中的 JSON 数组
  const match = cleaned.match(/\[[\s\S]*?\]/);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[0]);
    if (Array.isArray(parsed)) return parsed;
  } catch {}

  return null; // 最终没解析出数组返回 null
}

/**
 * 等待 DeepSeek 返回最终回答
 * page: Puppeteer 页面对象
 * lastCount: 当前已有消息数量
 */
async function waitForFinalAnswer(page, lastCount) {
  // DeepSeek 消息选择器
  const selector =
    'div[class*="messageContent"], div[class*="markdown"], div[class*="message-text"]';

  const start = Date.now(); // 开始时间
  let stableStart = Date.now(); // 上一次消息变化时间
  let prevLen = lastCount; // 上一次消息数量

  // 循环直到超时
  while (Date.now() - start < MAX_WAIT_TIME) {
    // 获取页面所有消息文本
    const messages = await page.$$eval(selector, nodes =>
      nodes.map(n => n.innerText.trim()).filter(Boolean)
    );

    if (messages.length > prevLen) {
      // 如果消息数量增加，更新 prevLen 和 stableStart
      prevLen = messages.length;
      stableStart = Date.now();
    } else if (Date.now() - stableStart > 2500) {
      // 如果消息稳定 2.5 秒以上，认为回答完成，返回最后一条
      return messages[messages.length - 1];
    }

    await delay(500); // 每 0.5 秒检查一次
  }

  // 超时未返回结果，抛出错误
  throw new Error('等待 DeepSeek 人名提取结果超时');
}

/* ---------------- 核心函数 ---------------- */

// 从文章文件中提取人名
async function extractNamesFromArticle(filePath) {
  // 检查文章文件是否存在
  if (!fs.existsSync(filePath)) {
    throw new Error('文章不存在: ' + filePath);
  }

  // 读取文章内容
  const text = fs.readFileSync(filePath, 'utf-8');
  // 获取文章文件名
  const fileName = path.basename(filePath);

  // 如果输出目录不存在，就创建
  if (!fs.existsSync(NAME_OUTPUT_DIR)) {
    fs.mkdirSync(NAME_OUTPUT_DIR, { recursive: true });
  }

  // 定义输出文件路径，把 .txt 替换为 .names.json
  const outputFile = path.resolve(
    NAME_OUTPUT_DIR,
    fileName.replace(/\.txt$/i, '.names.json')
  );

  // 启动 Puppeteer 浏览器
  const browser = await puppeteer.launch({
    headless: false, // 可视化浏览器
    defaultViewport: null, // 使用默认视口大小
    userDataDir: USER_DATA_DIR, // 使用用户数据目录
    executablePath: puppeteer.executablePath(), // 浏览器路径
    args: [
      '--no-sandbox', // 禁用沙箱
      '--proxy-server=direct://', // 直连，不使用代理
      '--proxy-bypass-list=*', 
      '--disable-blink-features=AutomationControlled' // 避免被检测为自动化
    ],
  });

  const page = await browser.newPage(); // 新建页面

  // 设置浏览器 User-Agent，模拟正常浏览器
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/117.0.0.0 Safari/537.36'
  );

  // 在新页面注入脚本，屏蔽 navigator.webdriver
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  console.log(`🔍 正在提取人名: ${fileName}`);

  // 打开 DeepSeek 网站
  await page.goto('https://chat.deepseek.com', {
    waitUntil: 'networkidle2', // 网络空闲时视为加载完成
    timeout: 0, // 不限制超时时间
  });

  // DeepSeek 消息选择器
  const selector =
    'div[class*="messageContent"], div[class*="markdown"], div[class*="message-text"]';

  // 获取当前已有消息数量
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
    // 找到输入框（textarea 或 contenteditable）
    const textarea =
      document.querySelector('textarea') ||
      document.querySelector('[contenteditable="true"]');

    if (!textarea) {
      throw new Error('未找到 DeepSeek 输入框');
    }

    textarea.focus(); // 聚焦输入框

    if (textarea.tagName.toLowerCase() === 'textarea' || textarea.tagName.toLowerCase() === 'input') {
      // 对于 textarea/input，设置 value 并触发 input 事件
      textarea.value = content;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // 对于 contenteditable，设置 innerText 并触发 input 事件
      textarea.innerText = content;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, prompt);

  await delay(300); // 等待 0.3 秒

  /* ===== 使用 Enter 发送 ===== */
  await page.keyboard.press('Enter'); // 模拟回车发送

  // 等待 DeepSeek 返回最终结果
  const rawResult = await waitForFinalAnswer(page, lastCount);

  // 尝试解析 JSON 数组
  const nameList = safeExtractJsonArray(rawResult);
  if (!nameList) {
    throw new Error(
      '❌ 无法从 DeepSeek 输出中解析出合法 JSON 数组:\n' + rawResult
    );
  }

  // 格式化输出
  const formatted = {
    file: fileName, // 原始文件名
    extractedAt: new Date().toISOString(), // 提取时间
    count: nameList.length, // 人名数量
    names: nameList.map(n => ({
      raw: n, // 原始名字
      normalized: normalizeName(n), // 标准化名字
    })),
  };

  // 写入输出文件
  fs.writeFileSync(outputFile, JSON.stringify(formatted, null, 2), 'utf-8');

  console.log(`✅ 人名提取完成，共 ${formatted.count} 个`);
  console.log(`📁 输出文件: ${outputFile}`);

  await browser.close(); // 关闭浏览器
  return formatted; // 返回结果对象
}

// 导出函数
module.exports = { extractNamesFromArticle };
