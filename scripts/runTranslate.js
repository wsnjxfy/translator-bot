// scripts/runTranslate.js

const path = require('path');
const { translateNames } = require('./nameTranslatorModule');

(async () => {
  try {
    console.log('🚀 开始人名翻译...');
    const result = await translateNames(); // 调用你修改的函数
    console.log('🎯 翻译结果:');
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('❌ 出现错误:', err);
  }
})();
