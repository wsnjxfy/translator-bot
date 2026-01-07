const fs = require('fs');
const path = require('path');
const { translateArticle } = require('./translateModule'); // 翻译模块
const { extractNamesFromArticle } = require('./nameExtractorModule'); // 人名提取模块

const ARTICLES_DIR = path.resolve(__dirname, '../articles');
const OUTPUT_DIR = path.resolve(__dirname, '../output');
const STATE_FILE = path.resolve(OUTPUT_DIR, 'translateState.json');

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

function getArticles() {
  if (!fs.existsSync(ARTICLES_DIR)) return [];
  return fs.readdirSync(ARTICLES_DIR)
    .filter(f => f.endsWith('.txt'))
    .map(f => path.join(ARTICLES_DIR, f));
}

async function translateManager() {
  const state = loadState();
  const articles = getArticles();

  for (const filePath of articles) {
    const fileName = path.basename(filePath);
    if (!state[fileName]) state[fileName] = { translated: false, names: [] };

    if (state[fileName].translated) {
      console.log(`✅ 已翻译: ${fileName}`);
      continue;
    }

    console.log(`🟡 开始处理: ${fileName}`);

    try {
      // ===== 第一步：提取人名 =====
      const nameData = await extractNamesFromArticle(filePath);
      state[fileName].names = nameData.names.map(n => n.raw); // 保存原始名字列表
      console.log(`🔹 提取到人名: ${state[fileName].names.join(', ')}`);

      // ===== 第二步：翻译文章 =====
      const { allSuccess } = await translateArticle(filePath);

      if (allSuccess) {
        state[fileName].translated = true;
        console.log(`✅ 完成翻译: ${fileName}（全部句子成功）`);
      } else {
        state[fileName].translated = false;
        console.log(`⚠️ 翻译未完全成功: ${fileName}（有句子失败）`);
      }

      saveState(state);

    } catch (err) {
      console.error(`❌ 处理出错: ${fileName}`, err);
      state[fileName].translated = false;
      saveState(state);
    }
  }

  // 删除已不存在的文章状态
  for (const file of Object.keys(state)) {
    if (!articles.some(a => path.basename(a) === file)) {
      console.log(`⚠️ 文件已删除: ${file}`);
      delete state[file];
      saveState(state);
    }
  }

  console.log('所有文章处理任务完成');
}

(async () => {
  try {
    await translateManager();
  } catch (err) {
    console.error('处理管理出错：', err);
  }
})();
