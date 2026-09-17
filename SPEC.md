# 一锅出 · 备餐管理器 — 技术规格 SPEC v2.1

> 本文件是前后端开发的唯一契约。v2 依据更新后的 PRD（五页架构：今日/配方/做饭/记录/设置）；v2.1 在 v2 基础上落地五项实施顾问需求。

> ## v2.1 变更摘要
> - **R3（加项口径）**：默认加项改为仅**蛋白粉 2 勺**（`229.8 kcal / P48 / C4.2 / F3.0`），`addonsOn` 默认 `true`；红薯不再计入默认加项，改为今日页晚加餐手动勾选；`DEFAULT_TODAY` 归零（`meals:0, whey:0, late:[]`），`normDaylog` 兜底同步。
> - **R4（食材锁定）**：recipes 在 `items` 之外新增 `locked` 字段（JSON id 数组，锁定食材克数在自动搭配中不参与重分配）；旧数据空数组 = 全部可变。
> - **R1（今日核销）**：正餐卡新增「吃了一份 · 核销」事件式按钮，与步进器并存。
> - **R2（本锅详情）**：做饭 done 页新增本锅食材/营养详情卡（内存渲染，不改表）。
> - **R5（速率驱动缺口）**：settings 新增 `targetWeight`、`weeklyRate`（kg/周）、`weightTrack`（bool）；gap 钳制放宽到 250–850；TDEE 可在开 weightTrack 时用最近体重记录计算。

> **原型参照（最高优先级视觉/交互/文案标准）**：`C:\Users\1\Documents\健身\meal-cook-prototype\`
> 含 index.html（结构）、app.js（交互逻辑）、mock.js（数据）、styles.css（视觉）、verify/*.mjs（数值断言）。
> subagent 开发时必须直接阅读原型文件对齐细节，本 SPEC 只定义差异与后端契约。

## 1. 架构（与 v1 一致）

```
单 Docker 容器（node:22-alpine）
├── backend/   Express 5 + better-sqlite3（REST API，端口 3000）
├── frontend/  Vue 3 + Vite（构建产物由 Express 静态托管）
└── /app/data  SQLite（卷挂载）
```

业务计算（今日摄入、每日预演、红黄绿校验、自动搭配、规则引擎）全部在前端实现（与原型 app.js 同构），后端只做 CRUD + 备份。

## 2. 数据模型 v2

### foods（含自定义，替代 v1 分类）
```sql
CREATE TABLE foods (
  id TEXT PRIMARY KEY,            -- 预设用语义 id（'rice'），自定义用 'c_<timestamp>'
  name TEXT NOT NULL,
  category TEXT NOT NULL,         -- 'grain'|'protein'|'veg'|'fat'|'custom'
  unit TEXT NOT NULL,             -- '干重'|'生重'|'克重'
  kcal REAL NOT NULL, protein REAL NOT NULL, carbs REAL NOT NULL, fat REAL NOT NULL,
  is_preset INTEGER NOT NULL DEFAULT 0   -- 预设不可删，自定义可增删
);
```
分类展示顺序：grain(1) protein(2) veg(3) fat(4) custom(5)。

### recipes（配方库；"当前配方"= settings.current_recipe_id）
```sql
CREATE TABLE recipes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  portions INTEGER NOT NULL,
  items TEXT NOT NULL,            -- JSON: {"rice":510,"pork_loin":500,...}
  locked TEXT NOT NULL DEFAULT '[]', -- v2.1 R4: JSON id 数组，锁定食材在 autoGenerate 中克数不变
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
```
> R4 锁定语义：`locked` 命中的食材视为「已买好/固定份量」，自动搭配只把其营养计入基数；旧配方（无 locked 字段）一律视为空数组 = 全部可变。API 的 recipe 对象收发均带 `locked` 数组。

### inventory（库存批次）
```sql
CREATE TABLE inventory (
  id TEXT PRIMARY KEY,            -- 'b-MMDD-N' 服务端生成
  name TEXT NOT NULL,
  portions REAL NOT NULL,
  in_at TEXT NOT NULL,            -- 'MM-DD HH:mm'
  per_kcal REAL NOT NULL, per_p REAL NOT NULL, per_c REAL NOT NULL, per_f REAL NOT NULL
);
```

### settings（key-value）
默认值（PRD 表 4-1）：`weight=90, height=175, age=30, sex='m', act=1.375, gap=750, proteinPer=1.5, fatRatio=23, manualTdee=null, addonsOn=true, current_recipe_id=1`
v2.1 R5 新增：`targetWeight=80, weeklyRate=0.5, weightTrack=false`
- `gap` 前端钳制由 500–900 **放宽为 250–850**（覆盖 0.25/0.5/0.75 kg/周 → 275/550/825 kcal）。
- `weightTrack=true` 时：计算 BMR/TDEE 所用体重 = **最近一次 `weights.kg` 记录**（TDEE 随减重自动衰减），并展示“按最近体重滚动计算”提示；手动 TDEE 仍优先覆盖。
- 建议缺口换算 = `weeklyRate × 7700 ÷ 7`（±25 kcal 取整展示，不强制覆盖手填 gap，仅作参考读数）。

### day_logs（每日打卡）
```sql
CREATE TABLE day_logs (
  date TEXT PRIMARY KEY,          -- 'YYYY-MM-DD'
  meals INTEGER NOT NULL,         -- 正餐份数 0-4
  whey INTEGER NOT NULL,          -- 蛋白粉勺数 0-6
  breakfast TEXT NOT NULL,        -- 选项 id：'none'|'egg_milk'|'sweet150'|'oat_milk'
  late TEXT NOT NULL,             -- 'none'|'sweet200'|'whey1'
  consumed REAL NOT NULL          -- 已从库存扣减份数（FIFO 已消耗）
);
```

### weights（体重）
```sql
CREATE TABLE weights (date TEXT PRIMARY KEY, kg REAL NOT NULL);
```

### rule_state（规则引擎状态）
```sql
CREATE TABLE rule_state (
  id INTEGER PRIMARY KEY CHECK (id=1),
  ignored TEXT NOT NULL DEFAULT '{}',   -- JSON: {"add_rice": <ms时间戳>,...}
  history TEXT NOT NULL DEFAULT '[]'
);
```

### 种子数据（投产干净库）
- **写入**：34 种预设食材（与原型 mock.js FOODS 逐项一致，含语义 id）、默认配方（name='一锅出', portions=6, items={rice:510,pork_loin:500,broccoli:400,carrot:400,corn:300,oil:60}）、settings 默认值、空 rule_state 一行
- **不写入**：体重/打卡/库存演示数据（那是原型演示用途，投产后由用户真实产生；前端需处理空状态：今日页无库存时按当前配方每份营养估算、记录页不足 7 天显示"数据不足"）

## 3. API v2 契约（前缀 /api，响应 `{code:0,data}` / 错误 `{code:1,message}`）

| 方法+路径 | 说明 |
|---|---|
| GET /api/foods | 预设+自定义，按 category 顺序返回 |
| POST /api/foods | 自定义食材（查重：同 category 同名拒绝；id 服务端生成） |
| DELETE /api/foods/:id | 仅允许删 is_preset=0 |
| GET /api/recipes | 配方库列表（含 items 解析与营养 totals） |
| POST /api/recipes | 新建；PUT /api/recipes/:id 更新；DELETE /api/recipes/:id 删除 |
| GET /api/settings | 对象形式（数值已反序列化）；PUT /api/settings 部分更新 |
| GET /api/inventory | 库存列表（新→旧） |
| POST /api/inventory | 批次登记 {name,portions,perKcal,perP,perC,perF}，服务端生成 id/in_at |
| POST /api/inventory/consume | FIFO 扣减 {portions}，返回 {inventory,consumed,shortage} |
| GET /api/day-logs | 全量（dict 形式 `{"2026-09-16":{...}}`） |
| PUT /api/day-logs/:date | upsert 当日打卡 |
| GET /api/weights | 列表（按日期升序） |
| POST /api/weights | upsert 当日体重 {kg}（同日覆盖） |
| GET /api/rule-state | {ignored,history}；PUT /api/rule-state 更新 |
| GET /api/backup | 全量导出 JSON（含 __exportedAt） |
| POST /api/backup | 导入 JSON，逐键覆盖写入，返回 {touched} |

营养计算规则、统一错误处理、SPA fallback 与 v1 相同。

## 4. 前端五页规格（以原型为准，此处仅列功能锚点）

导航：底部 5 Tab —— 今日 / 配方 / 做饭 / 记录 / 设置。

1. **今日（F5/F7）**：正餐步进 0-4、蛋白粉步进 0-6、早餐池（不吃/鸡蛋2个+牛奶250ml 300kcal P14C20F16/红薯150g/燕麦40g+牛奶250ml）、晚加餐池（不吃/红薯200g常态 122kcal/蛋白粉1勺 115kcal P24C2.1F1.5）、当日汇总 4 进度条+缺口读数、库存卡 FIFO 自动扣减（meals>consumed 时调 consume）、剩余≤2 份"该做饭了"提醒。每份营养参考：库存最新批次，无库存则当前配方每份。
   今日摄入 = per×meals + 勺×whey + 早餐 + 晚加餐（勺=114.9kcal P24 C2.1 F1.5）。
   **v2.1 R1 核销**：正餐卡新增「吃了 1 份 · 核销」主按钮 → meals+1 → 触发 consume 扣 1 份 → perSnap/落库；按钮上实时显示当前批次每份营养（取最近批次的 kcal）。步进器保留为修正工具（下调份数只改记录、不回补库存，加提示文案"下调仅改记录，库存不自动回补"）。核销为「事件式打卡」，打开页面默认 0 份（依赖 DEFAULT_TODAY 归零），不存在预填虚记。
2. **配方（F2/F3）**：搜索/分类筛选/自定义增删、自动搭配（算法见原型 verify-autogen.mjs：每餐目标=(目标−加项)/2，蔬菜均分150g、主食按剩余碳水、蛋白按剩余蛋白、油补脂肪缺口 5-15g；自然单位取整 NATURAL_UNITS）、每日预演红黄绿（|d|≤10% 绿 / ≤20% 黄 / >20% 红；红且未勾"我知道偏差"阻止保存）、缺口>900 提示过大、糙米替换 1/3 建议（配方含大米无糙米时）、配方库保存/载入/删除。
   加项（默认开）：**蛋白粉2勺 = 229.8kcal P48 C4.2 F3.0**（v2.1 R3 重定义，仅蛋白粉，无红薯）。
   **v2.1 R4 锁定**：已选食材行新增锁 toggle（🔒/🔓）；`autoGenerate` 改两阶段 —— 先对 `locked` 命中食材按现克数计入营养基数（克数不变），再对可变食材按扣除后的剩余目标分配；锁定蛋白已超目标时 toast 提示"锁定蛋白已近/超目标"，不产生负值。锁定状态随配方库持久化（`store.recipe.locked` ↔ recipes.locked，保存/载入都带）。做饭页称重清单对锁定食材标锁徽标。
3. **做饭（F4）**：当前配方可称重清单、大字称重卡（点击→已称✓，再点撤销）、分装份数微调、批次登记入库（含每份 P/C/F）。
   **v2.1 R2 本锅详情**：done 阶段在"已入库"下方新增「本锅详情」卡 —— 食材清单（名称+克重+口径徽标+自然单位换算）、每份营养 tiles、每份生料重、分装份数；内存渲染自 `store.recipe`，不改表、不做历史回看。
4. **记录（F6）**：体重录入（当日 upsert）、SVG 体重曲线+7日均线（原型 renderWeightChart 同构）、规则引擎卡片：
   - n<7：数据不足；n<14：观察期
   - drop14=ma14−maNow>2 →「两周累计降幅」（bad）建议大米 600g 档（rice600），**v2.1 R5 联动**：同时提示"缺口现按最近体重滚动，若掉秤偏快建议调低 weeklyRate 档"
   - drop7=ma7−maNow>1.2 →「掉秤偏快」（warn）每份大米+15g（plus15）
   - drop7<0.2 且打卡率≥80% →「接近平台」（warn）每份大米−15g（minus15，下限100g）
   - drop7<0.2 且打卡率<80% →「先修纪律」（warn，无 action）
   - 其余 → 目标区间（ok）
   - 均线=含当日的前7条均值；打卡率=近7天(含今日) meals>0 占比；忽略7天存 rule_state.ignored
   - 一键应用：调当前配方大米克重，重命名为「原名·调整版」并保存
5. **设置（F1）**：体重/身高/年龄/性别/活动系数(1.2/1.375/1.46/1.55/1.725/1.9)/目标缺口；实时计算链 Mifflin-St Jeor：BMR=10w+6.25h−5a+5(男)/−161(女)，TDEE=BMR×act（manualTdee 非空则覆盖），目标=TDEE−gap，P=w×proteinPer，F=目标×fatRatio%/9，C=(目标−4P−9F)/4；高级：蛋白系数/脂肪供能比。
   **v2.1 R5 目标速率**：新增「减重目标」区 —— 目标体重 targetWeight、周减速率 weeklyRate（0.25/0.5/0.75 kg/周三档）、复选框 weightTrack「TDEE 跟随最近体重记录」。weightTrack on 时计算链的 bodyweight 取 weights 最近一条；下方展示动态参考读数"建议缺口 = weeklyRate×7700÷7 ≈ {get 的 kcal} kcal"（0.25→275 / 0.5→550 / 0.75→825）。JSON 导出（GET /api/backup 下载）/导入（POST /api/backup）。

**验收断言（与原型 verify-all.mjs 一致）**：BMR 1849→TDEE 2542→目标 1792→宏量 135/46/210；默认配方 3715kcal/171P/521C/110F、每份 619kcal/28.5P；**v2.1 R3 重算**：每日预演 = 2×619+229.8 ≈ 1468kcal、缺口(=TDEE−预演)≈1074 ；默认搭配的每餐蛋白目标=(135−48)/2=43.5g；21天体重种子下 maNow≈90.90、ma7≈92.26、drop7=1.36 触发加主食、drop14≈1.61 不触发强提示；打卡率 6/7=86%。R5 校验：weightTrack on、最近体重 85 → BMR=10×85+6.25×175−5×30+5=1798.75、TDEE=1798.75×1.375≈2473、目标=2473−750=1723；weight=80.5 时 BMR=1753.75、TDEE≈2411、目标≈1661。

## 5. 质量要求（不变）

- 注释中文讲"为什么"；函数≤50 行；async 必 try/catch；不留 TODO
- 前端不引 UI 库/图标库/axios/vue-router；图标可用内联 SVG 或 emoji
- Windows PowerShell 5 + Node 22 本地开发
