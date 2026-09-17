# 一锅出 · 备餐管理器 — 技术规格 SPEC v2.5

> 本文件是前后端开发的唯一契约。v2 依据更新后的 PRD（五页架构：今日/配方/做饭/记录/设置）；v2.1 落地五项实施顾问需求；v2.2 落地「锅位可视化 + 事件化核销 + 成就感体系」；v2.3 修复配方保存的数据丢失缺陷；v2.4 把逐份核销重构为「一次性打卡 + 回撤」；v2.5 把配方页改为「结构化配方 + 目标导向微调」。

> ## v2.5 变更摘要（配方页改为「结构化配方 + 目标导向微调」）
> - **要解决的问题**：原配方页左栏常驻食材库、用户手填克数——微调时要回库里翻找已选食材，且用户没有能力反算「少吃饭该补多少克」，手动改克重会让热量目标漂移。
> - **结构化配方**：左栏改为按 主食 / 蛋白 / 蔬菜 / 油脂调料 / 自定义 分组展示已选食材；食材库退居**按需弹层**（点某组「＋ 添加」调出，默认筛到该类别，含分类 tabs、搜索、勾选式列表与自定义食材入口），弹层内取消勾选即从配方移除。
> - **微调只给方向**：已选行不再有克数输入框，改为 `− 克数 +`。一档 = **每份一个自然单位**（米 10g、蛋 1 个、油 1 瓷勺；`half` 单位取半档），整锅步进 = 每份步进 × 份数。
> - **同类内热量守恒**：`utils.adjustFoodByStep()` 只重算被调食材所属的那一类——调前记下该类整锅总热量 `E`，被调食材按档位变化后，同类**未锚定**的其余食材按现有热量比例缩放（`k = (E − Et1) / Ev0`），使该类热量守恒；**跨类食材克数一律不动**。
> - **调过即锚定**：± 调过的食材自动加入 `recipes.locked`，后续补偿不再动它；点锁图标可解除锚定。`autoGenerate` 的两阶段语义（v2.1 R4）不变。
> - **边界**：触到上下限（下限 1 个整锅步进、上限整锅 3000 g）返回 `blocked:'min'|'max'`；同类无其他可变食材时返回 `blocked:'no-companion'`，前端 toast 提示且不改数据。
> - **取整误差**：每档按自然单位取整，类热量守恒误差通常 ≤ 1%（实测 0.19%），由每日预演的红黄绿兜底，不引入迭代。
> - **新增食材初始量**：`CAT_DEFAULT_G[cat] × portions`（每份默认 × 份数）——`CAT_DEFAULT_G` 是每份语义而 `items` 存整锅克数，不乘会让新加入的食材少到不可用。

> ## v2.4 变更摘要（打卡模型重构：逐份核销 → 一次性确认 + 回撤）
> - **要解决的问题**：原「吃了 1 份 · 核销」逐份扣库存，而步进器下调只改记录、不回补库存，导致 `day_logs.consumed`（已扣库存）与 `meals`（记录份数）分叉。线上 2026-09-17 出现 `consumed=4 / meals=2`，2 份共 1396 kcal 未进入任何统计。
> - **新模型**：份数与库存**只在「打卡」这一个动作里同时变化**。今日页正餐卡三态 —— 未录体重（无打卡按钮）／已录体重未打卡（可调份数 + 「✅ 今日打卡」）／已打卡（只读 + 「回撤」）。
> - **前置条件**：打卡按钮仅在**已记录今日体重**后出现。
> - **数据模型**：`day_logs` 新增 `checked_in INTEGER NOT NULL DEFAULT 0`（0=未确认草稿，1=已确认）。
> - **库存**：`POST /api/inventory/consume` 扣空的批次**不再删除**，`portions` 置 0 保留（否则回撤时批次行已消失、份数无处归还）；列表查询过滤 `portions > 0`。新增 `POST /api/inventory/restore` 按 `batchId` 回补份数。
> - **老数据迁移**：库缺 `checked_in` 列时自动补列，并按 `meals > 0` 回填为已打卡（旧口径下调不回补，`consumed` 可能高于 `meals`，故以 `meals` 为准）；备份导入遇缺失 `checkedIn` 键时同口径推断，避免二次扣库存。

> ## v2.3 变更摘要（配方保存语义修复）
> - **缺陷**：工作区在启动时必定绑定 `current_recipe_id`（或首条），导致 `saveRecipe` 的 `id ? PUT : POST` 永远走 PUT —— **永远在覆盖，无法新建**。用户输入新名字点「存配方」实为给旧配方改名+覆盖内容，旧配方丢失。
> - **修复**：拆分为两条显式路径。「**存配方**」= 已绑定则更新那条、未绑定才新建；「**另存为**」= 强制 POST 新建，原配方不动。按钮文案动态标出覆盖目标（`存配方·覆盖「X」` / `存为新配方`），消除"以为在新建、实际覆盖"的歧义。
> - **连带修复**：① `api.saveRecipe` 漏传 `locked` → 新建配方丢锁定状态（违反 R4），现统一经 `recipeBody` 收发；② `goCook` 未回写新建返回的 id → 未绑定工作区每次进厨房会重复建条；③ 做饭页「清空重选」原把空配方存回服务端 = 静默抹掉原配方，现改为工作区脱离配方库（id 置空）且不落库。
> - **加项改为「达标建议值」表述**：`ADDONS`（蛋白粉 2 勺）在配方页不再表述为「已计入加项」（易被误读为已摄入），改为「**达标建议：打卡时补蛋白粉 2 勺（230 kcal）**」，并注明"预演已按此计入；未在今日页打卡记上，当日不计入"。计算口径不变（`dailyPreview` 总数仍含加项，红黄绿门禁与保存拦截逻辑不受影响），仅纠正语义表述——加项是打卡需补的建议量，不是已吃掉的量。

> ## v2.2 变更摘要
> - **R6（事件化核销）**：正餐核销改为「事件式」——每次核销 1 份走 FIFO 扣库存并返回实扣明细（每份来自哪个批次 + 营养），逐份追加进 `day_logs.meals_log`（`[{ts,batchId,batchName,per:{kcal,p,c,f}}]`）。每份营养锁定在核销时刻，不再「整体重拍快照」，修复连点双扣与口径错位。
> - **R7（锅位队列）**：今日页正餐卡改为「先入先吃」锅位队列，队首高亮、显示剩余份数与食材摘要（依赖 `inventory.items` 冻结整锅食材克重）。
> - **R8（成就感体系）**：今日页新增连续打卡 streak 🔥 徽章、今日 kcal 进度环、清锅彩蛋（某锅扣到 0 份时提示「锅X见底，吃了N天」）、饱腹感 1-5 录入（`day_logs.satiety`）；记录页新增历史锅位回溯、碳蛋脂供能比条、达标天数统计（|kcal−目标|≤10%）。
> - **数据模型**：`inventory` 加 `items TEXT`（整锅食材克重 JSON）；`day_logs` 加 `meals_log TEXT`、`satiety INTEGER`；backup 导出/导入补齐 `per_snap/batch_name/meals_log/satiety/items`。

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
  per_kcal REAL NOT NULL, per_p REAL NOT NULL, per_c REAL NOT NULL, per_f REAL NOT NULL,
  items TEXT                      -- v2.2: 整锅食材克重 JSON {"rice":510,...}，锅位队列展示用
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
  breakfast TEXT NOT NULL,        -- 加餐条目数组 JSON [{"id","g"}]（旧值字符串 id 由前端归一化）
  late TEXT NOT NULL,             -- 同上，晚加餐条目数组
  consumed REAL NOT NULL,         -- 已从库存扣减份数（FIFO 已消耗）
  per_snap TEXT,                  -- 打卡时每份营养快照 JSON {kcal,p,c,f}（旧口径兜底）
  batch_name TEXT,                -- 打卡时批次名，供回溯卡片展示
  meals_log TEXT,                 -- v2.2: 核销事件流 JSON [{ts,batchId,batchName,per:{kcal,p,c,f}}]
  satiety INTEGER NOT NULL DEFAULT 0, -- v2.2: 当日饱腹感 1-5，0=未记录
  checked_in INTEGER NOT NULL DEFAULT 0  -- v2.4: 打卡确认标记 0=未确认(草稿) 1=已确认
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
| POST /api/recipes | 新建（配方体含 name/portions/items/locked）；PUT /api/recipes/:id 更新；DELETE /api/recipes/:id 删除 |
| GET /api/settings | 对象形式（数值已反序列化）；PUT /api/settings 部分更新 |
| GET /api/inventory | 库存列表（新→旧） |
| POST /api/inventory | 批次登记 {name,portions,perKcal,perP,perC,perF,items?}，服务端生成 id/in_at；items 为整锅食材克重 JSON |
| POST /api/inventory/consume | FIFO 扣减 {portions}，返回 {inventory,consumed,shortage,detail}；detail=实扣明细 [{batchId,batchName,per}]。**v2.4**：扣空的批次不再删除，`portions` 置 0 保留，供回撤归还 |
| POST /api/inventory/restore | **v2.4** 回撤打卡 {items:[{batchId,portions}]}，按批次把份数加回，返回 {inventory}；batchId 不存在时静默跳过（历史批次可能已删） |
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

1. **今日（F5/F7）**：正餐步进 0-4、蛋白粉步进 0-6、早餐池（不吃/鸡蛋2个+牛奶250ml 300kcal P14C20F16/红薯150g/燕麦40g+牛奶250ml）、晚加餐池（不吃/红薯200g常态 122kcal/蛋白粉1勺 115kcal P24C2.1F1.5）、当日汇总 4 进度条+缺口读数、库存卡 FIFO 扣减（v2.4 起由「打卡」一次性触发，不再是 meals>consumed 差值驱动）、剩余≤2 份"该做饭了"提醒。每份营养参考：库存最新批次，无库存则当前配方每份。
   今日摄入 = per×meals + 勺×whey + 早餐 + 晚加餐（勺=114.9kcal P24 C2.1 F1.5）。
   **v2.4 一次性打卡（取代 v2.1 R1 逐份核销）**：正餐卡三态 —— ①**未录体重**：步进器可调 + 提示「先录今日体重，再回来打卡」，无打卡按钮；②**已录体重未打卡**：步进器可调 + 「✅ 今日打卡 · 确认 N 份」主按钮，点击后按份数一次性 `consume(N)`，返回的 `detail` 逐份写入 `meals_log`，`consumed` 与 `meals` 同步，`checked_in` 置 1 并锁定（步进器只读）；③**已打卡**：显示「已打卡 N 份」+「回撤」按钮，回撤按 `meals_log` 的 `batchId` 聚合份数调 `restore` 全额回补，清空 `meals_log`、`consumed` 归零、`checked_in` 置 0 并解锁。**份数与库存只在打卡这一个动作里同时变化，从结构上消除 consumed/meals 分叉。** 打卡后盘点被吃光的批次提示「🎉 锅X见底，吃了 N 天」。打开页面默认 0 份（依赖 DEFAULT_TODAY 归零），不存在预填虚记。
   **v2.2 R6/R7/R8 核销重构 + 成就感**（v2.4 起触发时机改为打卡）：事件式链路——按份数一次性 `consume(N)` 取实扣明细 `detail`，逐份追加进 `meals_log`（每份营养锁定在打卡时刻的批次），不再整体重拍快照（修复连点双扣与口径错位）。正餐卡改为「先入先吃」锅位队列（队首高亮 + 剩余份数 + 食材摘要 `items`）。页面头部新增 streak 🔥 徽章、今日 kcal 进度环（SVG 环形，达成度=摄入/目标）、饱腹感 1-5 星（再点同档取消）；某锅扣到 0 份时 toast「🎉 锅X见底，这一锅吃了N天」。
2. **配方（F2/F3）**：搜索/分类筛选/自定义增删、自动搭配（算法见原型 verify-autogen.mjs：每餐目标=(目标−加项)/2，蔬菜均分150g、主食按剩余碳水、蛋白按剩余蛋白、油补脂肪缺口 5-15g；自然单位取整 NATURAL_UNITS）、每日预演红黄绿（|d|≤10% 绿 / ≤20% 黄 / >20% 红；红且未勾"我知道偏差"阻止保存）、缺口>900 提示过大、糙米替换 1/3 建议（配方含大米无糙米时）、配方库保存/载入/删除。
   **v2.5 结构化配方与目标导向微调**：左栏由「常驻食材库」改为「结构化配方」——按 `grain/protein/veg/fat`（及非空的 `custom`）分组，每组显示类别名、已选数量与「＋ 添加」；组内 `PickedRow` 行只提供 `− 克数 +`、锚定锁（🔒/🔓）与移除（×）。食材库改为按需弹层（默认筛选到被点类别），弹层内取消勾选即从配方移除；`FoodRow` 增加可选 `pickOnly`（默认 false，仅弹层使用，隐藏克数输入与锁定）。微调算法见 `utils.adjustFoodByStep(items, id, dir, foods, anchors, portions)`：一档 = 每份一个自然单位，同类内按**热量守恒**补偿其余未锚定食材，跨类克数不动；± 调过的食材自动进入 `store.recipe.locked`。右栏（自动搭配 / 一锅总量 / 份数 / 每份营养 / 每日预演 / 进入厨房）保持不变。
   加项（默认开）：**蛋白粉2勺 = 229.8kcal P48 C4.2 F3.0**（v2.1 R3 重定义，仅蛋白粉，无红薯）。
   **v2.1 R4 锁定**：已选食材行新增锁 toggle（🔒/🔓）；`autoGenerate` 改两阶段 —— 先对 `locked` 命中食材按现克数计入营养基数（克数不变），再对可变食材按扣除后的剩余目标分配；锁定蛋白已超目标时 toast 提示"锁定蛋白已近/超目标"，不产生负值。锁定状态随配方库持久化（`store.recipe.locked` ↔ recipes.locked，保存/载入都带）。做饭页称重清单对锁定食材标锁徽标。
   **v2.3 保存语义**：`store.recipe.id` 语义 = 当前绑定到的库条目，`null` = 未保存的新工作区。配方库操作行两个入口 —— 「**存配方**」绑定则 PUT 更新那条、未绑定则 POST 新建，按钮文案直接标出覆盖目标（`存配方·覆盖「X」`／`存为新配方`）；「**另存为**」仅在已绑定时出现，强制 POST 新建一条且不触碰原配方。`api.js` 提供 `createRecipe`（强制新建）/`updateRecipe`（更新指定条）/`saveRecipe`（按 id 自动择一，供 `goCook` 持久化工作区用），三者统一经 `recipeBody` 收发 `locked`。做饭页「清空重选」= 工作区 id 置空并清空，不落库。
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
   **v2.2 历史饮食回溯增强**：每日回溯卡改为按 `meals_log` 聚合展示「吃了哪几锅各几份」（`summarizeMealsLog`），附碳蛋脂供能比条（`macroRatio`：蛋白 4/碳水 4/脂肪 9 kcal/g 折算占比）、饱腹感徽标（`satiety`）、以及头部「已达标 N/总天数」统计（达标 = |kcal−目标|≤10%，与 statusOf 绿档同口径）。旧数据（无 meals_log）回退按 `perSnap` 旧口径展示。
5. **设置（F1）**：体重/身高/年龄/性别/活动系数(1.2/1.375/1.46/1.55/1.725/1.9)/目标缺口；实时计算链 Mifflin-St Jeor：BMR=10w+6.25h−5a+5(男)/−161(女)，TDEE=BMR×act（manualTdee 非空则覆盖），目标=TDEE−gap，P=w×proteinPer，F=目标×fatRatio%/9，C=(目标−4P−9F)/4；高级：蛋白系数/脂肪供能比。
   **v2.1 R5 目标速率**：新增「减重目标」区 —— 目标体重 targetWeight、周减速率 weeklyRate（0.25/0.5/0.75 kg/周三档）、复选框 weightTrack「TDEE 跟随最近体重记录」。weightTrack on 时计算链的 bodyweight 取 weights 最近一条；下方展示动态参考读数"建议缺口 = weeklyRate×7700÷7 ≈ {get 的 kcal} kcal"（0.25→275 / 0.5→550 / 0.75→825）。JSON 导出（GET /api/backup 下载）/导入（POST /api/backup）。

**验收断言（与原型 verify-all.mjs 一致）**：BMR 1849→TDEE 2542→目标 1792→宏量 135/46/210；默认配方 3715kcal/171P/521C/110F、每份 619kcal/28.5P；**v2.1 R3 重算**：每日预演 = 2×619+229.8 ≈ 1468kcal、缺口(=TDEE−预演)≈1074 ；默认搭配的每餐蛋白目标=(135−48)/2=43.5g；21天体重种子下 maNow≈90.90、ma7≈92.26、drop7=1.36 触发加主食、drop14≈1.61 不触发强提示；打卡率 6/7=86%。R5 校验：weightTrack on、最近体重 85 → BMR=10×85+6.25×175−5×30+5=1798.75、TDEE=1798.75×1.375≈2473、目标=2473−750=1723；weight=80.5 时 BMR=1753.75、TDEE≈2411、目标≈1661。

## 5. 质量要求（不变）

- 注释中文讲"为什么"；函数≤50 行；async 必 try/catch；不留 TODO
- 前端不引 UI 库/图标库/axios/vue-router；图标可用内联 SVG 或 emoji
- Windows PowerShell 5 + Node 22 本地开发
