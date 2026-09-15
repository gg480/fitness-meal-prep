import { Router } from 'express';
import { db } from '../db.js';
import { wrap, HttpError, readAllSettings } from '../helpers.js';

const router = Router();

// 导入/导出都用"语义格式"（与各 GET 接口一致），备份文件人类可读可改，导入导出完全对称

function exportData() {
  return {
    foods: db.prepare('SELECT * FROM foods ORDER BY rowid').all(),
    recipes: db.prepare('SELECT * FROM recipes ORDER BY id').all()
      .map((r) => ({ ...r, items: JSON.parse(r.items) })),
    settings: readAllSettings(),
    inventory: db.prepare('SELECT * FROM inventory ORDER BY rowid DESC').all()
      .map((r) => ({ id: r.id, name: r.name, portions: r.portions, inAt: r.in_at,
        perKcal: r.per_kcal, perP: r.per_p, perC: r.per_c, perF: r.per_f })),
    day_logs: Object.fromEntries(
      db.prepare('SELECT * FROM day_logs ORDER BY date').all()
        .map((r) => [r.date, { meals: r.meals, whey: r.whey, breakfast: r.breakfast, late: r.late, consumed: r.consumed }])
    ),
    weights: db.prepare('SELECT date, kg FROM weights ORDER BY date ASC').all(),
    rule_state: (() => {
      const row = db.prepare('SELECT * FROM rule_state WHERE id = 1').get();
      return { ignored: JSON.parse(row.ignored), history: JSON.parse(row.history) };
    })(),
    __exportedAt: new Date().toISOString(),
  };
}

router.get('/', wrap((req, res) => {
  res.json({ code: 0, data: exportData() });
}));

// 各表"清空+重灌"写入器：字段从语义格式还原成 DB 列，全部显式列出防字段漂移
function importWriters(data) {
  return {
    foods: () => {
      const ins = db.prepare(`INSERT INTO foods (id, name, category, unit, kcal, protein, carbs, fat, is_preset)
        VALUES (@id, @name, @category, @unit, @kcal, @protein, @carbs, @fat, @is_preset)`);
      for (const f of data.foods) ins.run(f);
    },
    recipes: () => {
      const ins = db.prepare('INSERT INTO recipes (id, name, portions, items, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
      for (const r of data.recipes) ins.run(r.id, r.name, r.portions, JSON.stringify(r.items), r.created_at, r.updated_at);
    },
    settings: () => {
      const ins = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
      for (const [key, value] of Object.entries(data.settings)) ins.run(key, JSON.stringify(value));
    },
    inventory: () => {
      const ins = db.prepare(`INSERT INTO inventory (id, name, portions, in_at, per_kcal, per_p, per_c, per_f)
        VALUES (@id, @name, @portions, @inAt, @perKcal, @perP, @perC, @perF)`);
      for (const b of data.inventory) ins.run(b);
    },
    day_logs: () => {
      const ins = db.prepare('INSERT INTO day_logs (date, meals, whey, breakfast, late, consumed) VALUES (?, ?, ?, ?, ?, ?)');
      for (const [date, log] of Object.entries(data.day_logs)) {
        ins.run(date, log.meals, log.whey, log.breakfast, log.late, log.consumed);
      }
    },
    weights: () => {
      const ins = db.prepare('INSERT INTO weights (date, kg) VALUES (?, ?)');
      for (const w of data.weights) ins.run(w.date, w.kg);
    },
    rule_state: () => {
      const rs = data.rule_state;
      db.prepare("INSERT INTO rule_state (id, ignored, history) VALUES (1, ?, ?)")
        .run(JSON.stringify(rs.ignored), JSON.stringify(rs.history));
    },
  };
}

// 导入：逐表"先清空再重灌"（覆盖语义），单事务保证全成功或全回滚
router.post('/', wrap((req, res) => {
  // 兼容前端把整个 {code:0,data:{...}} 响应原样存盘再导入的情况
  const payload = req.body || {};
  const data = payload.data && typeof payload.data === 'object' ? payload.data : payload;

  const writers = importWriters(data);
  const touchedTables = Object.keys(writers).filter((key) => data[key] !== undefined);
  if (touchedTables.length === 0) throw new HttpError(400, '文件中没有可识别的备份数据');

  const run = db.transaction(() => {
    for (const key of touchedTables) {
      // 表名来自 writers 的代码内白名单（非用户输入），拼接无注入风险
      db.prepare(`DELETE FROM ${key}`).run();
      writers[key]();
    }
  });
  run();
  res.json({ code: 0, data: { touched: touchedTables.length } });
}));

export default router;
