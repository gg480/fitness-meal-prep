import { Router } from 'express';
import { db } from '../db.js';
import { wrap, HttpError } from '../helpers.js';
import { CARDIO_FORMS } from '../seed.js';

const router = Router();

/* T-114 有氧记录：后端只做 CRUD，热量消耗一律由前端按「（活动心率 ÷ 静息心率 × 6.4 − 6.2）× 体重 × 小时」
 * 现算（与项目既有口径一致：全部营养计算在前端，后端不参与推导）。派生值不入库，
 * 否则用户改了体重或静息心率后，历史记录会停在旧参数算出的消耗上。 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MIN_HR = 60;      // 运动心率下限：再低连静息都算不上，多半是录错了
const MAX_HR = 220;     // 通用理论最大心率，超出必为手滑
const MAX_MINUTES = 600; // 单次 10 小时上限：防多打一个 0 把置换出的饮食量算爆

// body 校验：date 由前端传（容器为 UTC，服务端自己算"今天"会差一天）
function assertCardioBody(body) {
  if (!DATE_RE.test(body.date || '')) throw new HttpError(400, 'date 格式应为 YYYY-MM-DD');
  const minutes = Number(body.minutes);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_MINUTES) {
    throw new HttpError(400, `minutes 必须为 0–${MAX_MINUTES} 的正数`);
  }
  // 运动心率可留空：前端按推荐强度 120 估算，并在界面上标注这是估算值
  if (body.hr !== undefined && body.hr !== null && body.hr !== '') {
    const hr = Number(body.hr);
    if (!Number.isInteger(hr) || hr < MIN_HR || hr > MAX_HR) {
      throw new HttpError(400, `hr 必须为 ${MIN_HR}–${MAX_HR} 的整数，或留空按推荐心率估算`);
    }
  }
  // form 缺省落 'other'（老客户端不传也存得下）；显式给了就必须在枚举内
  if (body.form !== undefined && body.form !== null && !CARDIO_FORMS.includes(body.form)) {
    throw new HttpError(400, 'form 只允许 ' + CARDIO_FORMS.join('/'));
  }
}

// 行 → API 形状（camelCase，与备份导出的语义格式一致）
const rowToLog = (row) => ({
  id: row.id, date: row.date, minutes: row.minutes,
  hr: row.hr, form: row.form, createdAt: row.created_at,
});

// 全量升序返回：本周窗口由前端按浏览器日期过滤，后端不猜"这周"从哪天开始（时区口径见权重路由同理）
router.get('/', wrap((req, res) => {
  const rows = db.prepare('SELECT * FROM cardio_logs ORDER BY date ASC, id ASC').all();
  res.json({ code: 0, data: rows.map(rowToLog) });
}));

// 新增一条：一天可多次，不做按日 upsert（早晚各一次有氧是常态，合并会丢失次数与时长明细）
router.post('/', wrap((req, res) => {
  const body = req.body || {};
  assertCardioBody(body);
  const hr = body.hr === undefined || body.hr === null || body.hr === '' ? null : Number(body.hr);
  // 时长按 0.1 网格收整，避免 30.33333 式浮点残渣进库（与份数的精度约定同思路）
  const minutes = Math.round(Number(body.minutes) * 10) / 10;
  const info = db.prepare('INSERT INTO cardio_logs (date, minutes, hr, form) VALUES (?, ?, ?, ?)')
    .run(body.date, minutes, hr, body.form || 'other');
  const row = db.prepare('SELECT * FROM cardio_logs WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ code: 0, data: rowToLog(row) });
}));

// 删除一条：按 id 精确删除，不做"删当天全部"的批量动作（误删一次就是一天记录全没了）
router.delete('/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  // id 不合法时直接 400：better-sqlite3 不接受 NaN 绑定，放任下去会变成 500
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'id 必须为正整数');
  const info = db.prepare('DELETE FROM cardio_logs WHERE id = ?').run(id);
  if (info.changes === 0) throw new HttpError(404, '有氧记录不存在');
  res.json({ code: 0, data: { ok: true } });
}));

export default router;
