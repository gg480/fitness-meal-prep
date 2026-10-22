# 设计文档：本日实际摄入记录（分餐核销 + 外食菜品库 + 加餐）

日期：2026-10-22
状态：已获用户批准（方案 A / 步进 0.5 份 / 加餐不设上限）
版本基线：SPEC v3.2 → 本特性建议升 v3.3.0（跟随 SPEC.md 标题）

## 1. 背景与目标

现有系统只有"计划端"（配额、配方、打卡批次数），缺"实际端"：本日每餐实际吃了几份、外食吃了什么、加餐。本模块补齐实际端记录，并与既有外食两日补偿（T-130）联动。

用户口径：
- 记录粒度只到"吃了/没吃/吃了几份"（0.5 份一档），不称重
- 外食一周约两次，餐馆点菜为主，按常去地点建外食菜品库，支持新增
- 记录归记录、缺口照算：外食记录自动进入现有补偿机制（后两日缺口增加）
- 加餐独立档位，不设上限
- 买菜清单本次不做

## 2. 方案选择

采纳**方案 A：扩展现有 meals_log 体系**（已否决：B 独立 intake_entries 表需两套数据对账；C 纯前端打勾存不进快照）。

## 3. 数据模型

### 3.1 新表 `eatery_dishes`（外食菜品库）
```sql
CREATE TABLE eatery_dishes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,          -- 菜名，如"鱼香肉丝"
  eatery TEXT DEFAULT '',      -- 常去地点/店名，可空
  slot TEXT NOT NULL,          -- 惯用餐次 lunch/dinner 等
  kcal REAL NOT NULL,
  p REAL NOT NULL, c REAL NOT NULL, f REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_eatery_dishes_eatery ON eatery_dishes(eatery);
```
- 同名+同店视为同条目，新增时 upsert（避免重复堆积）
- 营养值为"一整份"口径，由用户凭经验填（不做精确校验）

### 3.2 复用既有结构（不改表结构）
- `day_logs.meals_log`：核销事件流，每条带 `slot` + `per` 快照。本模块追加两类事件：
  - `kind: 'portion'`：计划核销，`slot` ∈ breakfast/lunch/dinner/snack，`shares` ∈ {0, 0.5, 1, 1.5, …}（0.5 步进），`per` 取当日该餐计划配额快照
  - `kind: 'outing'`：外食记录，复用现有 `outing` 结构（eat/drink/both + 折算营养），但来源挂菜品库条目 id
- `slot` 枚举扩为 `breakfast | lunch | dinner | snack`（snack 为新增）

## 4. API 设计

- `GET /api/eatery-dishes?eatery=` 列表（按店分组返回）
- `POST /api/eatery-dishes` 新增/更新（upsert by name+eatery）
- `DELETE /api/eatery-dishes/:id` 删除
- `POST /api/day-logs`（既有 upsert）扩展：接受 `meals_log` 中的 `portion` 事件与 `outing.fromDishId`；后端做 0.5 步进与 slot 枚举校验

## 5. 前端交互（TodayView.vue）

1. **每餐卡片"实际"区**：计划份数展示 + stepper（-0.5/+0.5，范围 0~2 份）+ 「没吃」快捷键；核销后卡片显示"已吃 X 份 / 计划 Y 份"与偏差色（不足=灰、达标=绿、超出=橙）
2. **外食入口**：每餐卡片「外食」按钮 → 弹层选店 → 选菜品（可多选）→ 确认记录；库里没有则当场新增（表单复用 CustomFoodForm 模式）
3. **加餐行**：今日页新增加餐卡片，独立记录（同 stepper，不占正餐配额，无上限提示）
4. **汇总条**：今日页顶部"已吃 vs 配额 vs 剩余"（正餐 portion 折算 + 外食折算 + 加餐）

## 6. 联动口径

- **补偿**：外食记录照常写入 `outing`，`outingPenaltyOf`（frontend/src/utils.js）不动，后两日缺口自动生效
- **加餐**：仅记录与汇总展示，**不参与**配额引擎和补偿计算（用户明示不设上限，减脂纪律由用户自控）
- **per_snap 快照**：portion 事件的快照取核销时刻的当日计划值；补打卡（v3.1.1 既有口径）沿用"只补记录不重算"

## 7. 测试与验证

- verify 断言：eatery_dishes CRUD upsert 去重、0.5 步进校验、slot 枚举校验、加餐不进补偿、portion+outing 混合日的汇总计算
- 真实老库跑一遍 + Playwright 实点：每餐核销、外食记录（新店新菜）、加餐记录、次日晚餐目标增加（补偿生效）
- 交互必点（历史教训：computed 漏 .value 类错误编译期无感）

## 8. 明确不做（YAGNI）

- 称重/克数级记录、拍照 AI、条码、买菜清单、外食精确定位、加餐上限
