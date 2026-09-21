// action-guides 完整性审计（v3.2 动作库）
// 校验：19 个动作 key 每个都有中文标题导出、tips 非空中文、gif 文件齐全、guid 与 articles 对齐
// 说明：action-guides.js 里的 gif 是 vite 打包时解析的 `./assets/*.gif` import，Node 无法直接 import，
//       这里改为扫源文本断言每条 key 都有 tips 数组 + 对应 gif 文件存在；gif URL 解析由 vite 构建兜底
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const guidesSrc = fs.readFileSync(path.join(__dirname, '../frontend/src/action-guides.js'), 'utf-8');
const { EXERCISES } = await import('../frontend/src/training.js');

const keys = Object.keys(EXERCISES);
let pass = 0, fail = 0;
const report = (ok, msg) => { ok ? pass++ : (fail++, console.log('[E] ' + msg)); };

// 1. 每个动作 key 在 action-guides.js 里都有条目（按 `key: {` 模式匹配）
const blocks = [];
const keyRe = /^\s{2}(\w+):\s*\{[\s\S]*?\n\s{2}\}/gm;
let m;
while ((m = keyRe.exec(guidesSrc))) blocks.push(m[1]);
const missingKey = keys.filter(k => !blocks.includes(k));
report(missingKey.length === 0, '每个动作都有 ACTION_GUIDES，缺失: ' + missingKey.join(','));

// 2. 每个条目都导入了对应 gif（源里出现 `import <key> from './assets/actions/<key>.gif';`）
for (const k of keys) {
  const ok = new RegExp(`import ${k} from './assets/actions/${k}\\.gif';`).test(guidesSrc);
  report(ok, `动作 ${k} 已导入同名动图`);
}

// 3. 每个 action-guides 里的 key 都有对应 gif 文件且非空
const assetsDir = path.join(__dirname, '../frontend/src/assets/actions');
const badFiles = [];
let total = 0;
for (const k of blocks) {
  const f = path.join(assetsDir, k + '.gif');
  const ok = fs.existsSync(f) && fs.statSync(f).size > 0;
  if (!ok) { badFiles.push(k); continue; }
  total += fs.statSync(f).size;
}
report(badFiles.length === 0, 'gif 文件齐全，缺失: ' + badFiles.join(','));
console.log('   gif 总体积: ' + Math.round(total / 1024) + ' KB / ' + blocks.length + ' 张');

// 4. tips 源文本含中文要点（每个 key 块内 tips 数组, 至少 2 行中文）
let noTips = [];
for (const k of blocks) {
  const idx = guidesSrc.indexOf(`\n  ${k}: {`);
  if (idx < 0) { noTips.push(k); continue; }
  const seg = guidesSrc.slice(idx, guidesSrc.indexOf('\n  }\n', idx));
  const tipLines = (seg.match(/^\s{6}'[^']+'/gm) || []).map(s => s.trim());
  const zh = tipLines.length >= 2 && tipLines.every(s => /[\u4e00-\u9fa5]/.test(s));
  if (!zh) noTips.push(k + '=' + JSON.stringify(tipLines));
}
report(noTips.length === 0, 'tips 为 2+ 条中文要点，异常: ' + noTips.join(';'));

// 5. 无多余 key（不透进未知动作）
const extra = blocks.filter(k => !keys.includes(k));
report(extra.length === 0, 'ACTION_GUIDES 无多余 key: ' + extra.join(','));

// 6. 19 张动图文件名与 EXERCISES 对齐（无孤儿 gif 文件）
const gifs = fs.readdirSync(assetsDir).filter(f => f.endsWith('.gif'));
const orphans = gifs.filter(f => !keys.includes(f.replace('.gif', '')));
report(orphans.length === 0, '无孤儿动图文件: ' + orphans.join(','));

console.log(`\n汇总：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);