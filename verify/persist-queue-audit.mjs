/* persist-queue 审计（T-136 审查修复）：persistToday 保存串行化
 * A/B/C 行为级断言 createSaveQueue（utils.js），D 源码级钉住 TodayView 挂接 */
import { readFileSync } from 'fs';
import { createSaveQueue } from '../frontend/src/utils.js';

const results = [];
const assert = (name, cond, detail) => results.push({ name, pass: !!cond, detail: detail || '' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

try {
  /* A. 串行顺序：并发 enqueue 多个任务，run 按入队顺序执行且互不重叠 */
  {
    const log = [];
    let running = false;
    let overlap = false;
    const q = createSaveQueue(async () => {
      if (running) overlap = true;
      running = true;
      const seq = log.length;
      await sleep(20);
      log.push(seq);
      running = false;
    });
    await Promise.all([q(), q(), q()]);
    assert('A. 串行执行不重叠', !overlap);
    assert('A. 执行顺序 = 入队顺序', log.join(',') === '0,1,2', 'order=' + log.join(','));
  }

  /* B. 出队取最新状态：排队窗口内的状态更新由出队时刻读取（中间态合并为最新） */
  {
    let state = 0;
    const seen = [];
    const q = createSaveQueue(async () => { seen.push(state); });
    state = 1;
    const p1 = q();
    state = 2;
    const p2 = q();
    await Promise.all([p1, p2]);
    assert('B. run 出队时读到最新状态', seen.every(s => s === 2), 'seen=' + seen.join(','));
  }

  /* C. 单次失败不阻断：run 抛错后链不断，后续 enqueue 仍执行、enqueue 返回的 promise 不 reject */
  {
    let calls = 0;
    const q = createSaveQueue(async () => {
      calls++;
      if (calls === 1) throw new Error('网络抖动');
    });
    let rejected = false;
    await q().catch(() => { rejected = true; });
    await q();
    assert('C. 失败不向外抛（不阻断界面汇总）', !rejected);
    assert('C. 后续保存仍执行', calls === 2, 'calls=' + calls);
  }

  /* D. 源码级：TodayView 的 persistToday 走 createSaveQueue，不再裸发 PUT */
  {
    const src = readFileSync(new URL('../frontend/src/views/TodayView.vue', import.meta.url), 'utf8');
    assert('D. import createSaveQueue', /import\s*\{[^}]*createSaveQueue[^}]*\}\s*from\s*'\.\.\/utils'/.test(src));
    assert('D. 队列挂接 createSaveQueue(', /createSaveQueue\(/.test(src));
    assert('D. persistToday 走串行队列', /function\s+persistToday\s*\(\s*\)\s*\{[\s\S]{0,120}?enqueueSave\(\)/.test(src));
    const persistBody = (src.match(/async function persistToday[\s\S]*?\n\}/) || [])[0] || '';
    assert('D. persistToday 主体不再直接调 api.saveDayLog（移入队列 run）', !persistBody.includes('api.saveDayLog'));
  }
} catch (e) {
  results.push({ name: '审计脚本异常', pass: false, detail: String(e) });
}

let failCount = 0;
for (const r of results) {
  console.log((r.pass ? 'PASS' : 'FAIL') + ' [' + r.name + ']' + (r.detail ? ' ' + r.detail : ''));
  if (!r.pass) failCount++;
}
console.log(failCount === 0 ? 'PASS：persist-queue 审计全绿' : 'FAIL：' + failCount + ' 项未过');
process.exit(failCount === 0 ? 0 : 1);
