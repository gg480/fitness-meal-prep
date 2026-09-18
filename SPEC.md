# 一锅出 · 备餐管理器 — 技术规格 SPEC v2.6

> 本文件是前后端开发的唯一契约。v2 依据更新后的 PRD（五页架构：今日/配方/做饭/记录/设置）；v2.1 落地五项实施顾问需求；v2.2 落地「锅位可视化 + 事件化核销 + 成就感体系」；v2.3 修复配方保存的数据丢失缺陷；v2.4 把逐份核销重构为「一次性打卡 + 回撤」；v2.5 把配方页改为「结构化配方 + 目标导向微调」；v2.6 对齐「好人松松」减脂方法论（配额模式 + 餐次分包 + 小数份核销 + 食物性质）。

> ## v2.6 变更摘要（对齐「好人松松」减脂方法论）
> - **配额模式（并行计算路径）**：`settings.calcMode` 择一 —— `tdee`（原「BMR → TDEE → 减 gap → 反推宏量」链路，逐字节不变）或 `quota`（查官方 g/kg 配额表，热量是结果而不是输入）。两派返回同名的 `c/p/f/kcal`，下游红黄绿、预演、配方库校验无需分支。
> - **餐次分包**：`recipes` / `inventory` 新增 `meal_allocation`，表达「某个餐次取走几份」（餐次域 = breakfast/lunch/pre/post/dinner，`snack` 不进分包）；守恒不变量 **Σ 槽位 = portions**。`inventory.meal_allocation` 为 `NULL` 表示未分包旧批次（份数可被任意餐次取用），与已分包严格区分，旧数据零回填。
> - **分餐引擎 `mealTargets(dayType, trainSlot, quota, carbStage?)`**：按 `CARB_RATIO` 把全天配额拆到各餐 —— 训练日按七种力训时间点取 20/20/20/40 的碳水集中（早饭兼练前餐时该餐 40%），休息日/无训练走 30/30/30/10；减脂末期传第 4 参 `carbStage='late'` 时改走 `CARB_RATIO_LATE`：早饭 3 / 练前 2 / 练后 5 单位，**其他餐碳水归零**（初期口述比例 2:2:4:2，末期 3:2:5），`carbStage` 缺省 / 脏值一律等价于初期表（老调用点行为逐字节不变），取值由 `store.mealStage`（`phase === 'cut' && carbStage === 'late'` 才为 `'late'`）统一给出；练后餐硬约束**蛋白 30–50 g、脂肪 ≤20 g**，余数由最后一个非练后餐吸收。
> - **小数份核销**：`day_logs.meals` 由 `INTEGER 0-4` 改为 `REAL 0–8`（最多 1 位小数，落库收在 0.1 网格）；`consume` / `restore` 新增 `mealSlot`，按餐次隔离扣减并与回补严格对称。
> - **规则引擎重写**：判据由「7 日均线周降幅」改为「近 14 天体重变化率 × 阶段阈值」（增肌 +1%~+2%、减脂 −2%~−3%），动作按 `calcMode` 分流（配额模式调碳水 ±0.5 g/kg，TDEE 模式调每份大米 ±15 g），另加「停止减脂」「重算配额」两条提醒。**T-126 起变化率改由「相邻两个 14 天窗口的体重均值」相减得出**（见下）。
> - **食物性质**：`foods.nature`（13 值枚举）标注瘦肉 / 高脂肉 / 糖油混合物 / 吸油菜等；排除清单三类**只提示不拦截**，生熟重口径只对干重主食提示，**均不参与任何营养计算**。
> - **（T-126 增量）日类型按天登记**：`day_logs` 新增 `day_type TEXT`（`'train'|'rest'|'none'`，`NULL` = 未登记）。当天生效的日类型 = **当日登记值 → `settings.dayType`（自此降级为「默认日类型」）→ `'none'`**，由 `utils.pickDayType()` 统一给出（`store.todayDayType`）。登记只作用于登记那天：昨天登记过训练日、今天没登记就回到默认值。今日页 / 配方页 / 做饭页与 `calcQuotaProfile` 全部改读该生效值。
> - **（T-126 增量）餐次开关 `settings.mealSlotsOff`**：元素 ∈ 六餐全集（`breakfast/lunch/pre/post/dinner/snack`），默认 `[]`（全开），去重后不可全关（全关 → 400）。关闭的餐次从当天分餐结构整体移除，其碳水比例按比例归一化给其余餐次（`Σ carbRatio` 仍 = 1、各餐合计仍 = 全天配额）；`mealTargets` 因此追加可选第 5 形参 `slotsOff`。**「零食/夜宵」在口径上就是那张「晚加餐」机动卡**，故关闭 `snack` 时今日页整张「晚加餐」卡隐藏（不是留空壳）；早餐是独立餐次、不受影响。
> - **（T-126 增量）`settings.lastRecalcWeight`**：`null` | `30–200`，默认 `null` = 从未重算，是「减脂每降 5 kg 提醒重算配额」的基准（此前退化用首条体重记录当基准，基准不动会让提醒一直挂着）。
> - **（T-126 增量）规则引擎判定口径 = 双窗均值**：变化率 =（近 14 天窗口体重均值 − 紧邻其前 14 天窗口体重均值）÷ 前窗均值。**行为变化：判定从此需要前后两窗各至少 1 条记录（约两周数据），原「首末跨度 ≥ 7 天 → 观察期」的门槛已取消**；近窗一条都没有 → 引擎不运行，前窗没有记录 → 只给观察期。`evalRules` 新增动作 `recalc_quota`（一键把当前体重写入 `settings.lastRecalcWeight`）。
> - **（T-129 增量）外食 / 喝酒的记录与随餐修正**：`day_logs` 新增 `outing TEXT`（`NULL` = 未登记），形状 `{type,level,baijiu,beer,slot}`。类型 ∈ `eat`/`drink`/`both`，外食量级 ∈ `light`/`normal`/`big`（**粗档位估算**：约 375 / 530 / 840 kcal），酒量按官方换算 **1 两白酒 ≈ 1 瓶啤酒 ≈ 200 kcal ≈ 50g 碳水**（整块记作碳水，不占蛋白与脂肪额度）。一条记录同时起两个作用：① 折算营养经 `utils.dayIntake` **计入当日摄入**（今日环 / 各餐完成度 / 记录页回溯与达标天数一起变）；② 经新增的 `utils.adjustForOuting(plan, outing)` 把缺口**只从「外食餐次的前后两餐」按各自目标占比扣**（顺序 `c → p → f`，即碳水优先；每餐扣到 0 即停、绝不出现负数），**叠加在 `mealTargets` 之上**（后者的签名与返回结构一字未动）。硬不变量：前后两餐扣得动时 `Σ 各餐 = 全天配额 − 外食占用` 严格成立；扣不动时差额必须在界面明示「今天已超 X kcal」。删除记录即回落（未登记时各餐目标逐值等于原结构）。今日页新增「外食 / 喝酒」卡（一次点击即登记、一个按钮即删除，不做向导），各餐行同时显示「原值 → 现值」。
> - **（T-129 增量）两处界面口径收口**：① 设置页「训练时间点」的禁用条件改为按**当日生效的日类型**（`store.todayDayType`）判断 —— T-126 起日类型按天登记，只判 `settings.dayType` 会让「当天登记为训练日、而默认日类型不是训练日」的用户改不了练前餐序（引擎计算本不受影响，是纯界面失配）；② 关闭「零食/夜宵」后，此前已记录的晚加餐条目**仍计入当日摄入**（真实吃过的不抹掉），但今日页与设置页都要明说这一点，不再"卡隐藏了、数字还在"地静默不一致。
> - 数据契约与实现偏差登记见 `契约-配额模式与餐次分包.md`（第八章）。

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
  nature TEXT NOT NULL DEFAULT 'other',  -- v2.6: 食物性质，13 值枚举，未标注 = 'other'（不提示不拦截）
  is_preset INTEGER NOT NULL DEFAULT 0   -- 预设不可删，自定义可增删
);
```
分类展示顺序：grain(1) protein(2) veg(3) fat(4) custom(5)。

**v2.6 `nature` 枚举（前后端唯一权威）**：`lean_meat` 瘦肉 / `high_fat_meat` 高脂肉 / `sugar_oil` 糖油混合物 / `oil_suck` 吸油菜 / `staple` 主食 / `veg` 蔬菜 / `fruit` 水果 / `egg` 蛋类 / `milk` 奶类 / `protein_powder` 蛋白粉 / `nut` 坚果 / `oil` 油脂 / `other` 其他。后端 `NATURE_KEYS` 与前端 `constants.js` 的 `NATURES` 逐值一致；写入时缺省/空串落 `other`，传了非法值 → 400。老库靠幂等 `ALTER TABLE` 补列（整表落 `other`），预设食材的标注由 `backfillPresetNatures()` 只回填「仍是 `other` 的预设行」，幂等且不覆盖用户改过的值。
性质**只驱动今日页提示层**（`high_fat_meat` / `sugar_oil` / `oil_suck` 三类排除清单提示；`staple` + 单位「干重」触发生熟口径提示），**不改克数、不拦截记录、不参与任何营养计算**。

### recipes（配方库；"当前配方"= settings.current_recipe_id）
```sql
CREATE TABLE recipes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  portions INTEGER NOT NULL,
  items TEXT NOT NULL,            -- JSON: {"rice":510,"pork_loin":500,...}
  locked TEXT NOT NULL DEFAULT '[]', -- v2.1 R4: JSON id 数组，锁定食材在 autoGenerate 中克数不变
  meal_allocation TEXT NOT NULL DEFAULT '{}', -- v2.6: 餐次分包 JSON {"breakfast":1.2,...}，'{}' = 未分包
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
```
> R4 锁定语义：`locked` 命中的食材视为「已买好/固定份量」，自动搭配只把其营养计入基数；旧配方（无 locked 字段）一律视为空数组 = 全部可变。API 的 recipe 对象收发均带 `locked` 数组。
> v2.6 分包语义：`mealAllocation` 是 `餐次 → 该餐取走的份数` 的映射，键域 ⊆ `breakfast/lunch/pre/post/dinner`（`snack` 不进分包），值为 0.1 的整数倍且 **Σ = portions**（容差 `1e-6`）；`{}` = 未分包（旧数据态）。**不同克重由份数差表达**（该餐克重 = 份数 × `items/portions`）——同一锅是均质混合物，物理上只能拆出不同克重、拆不出不同配比。**DEFAULT '{}' 让旧配方在 `ALTER TABLE` 时自动获得未分包态，零数据回填。**

### inventory（库存批次）
```sql
CREATE TABLE inventory (
  id TEXT PRIMARY KEY,            -- 'b-MMDD-N' 服务端生成
  name TEXT NOT NULL,
  portions REAL NOT NULL,
  in_at TEXT NOT NULL,            -- 'MM-DD HH:mm'
  per_kcal REAL NOT NULL, per_p REAL NOT NULL, per_c REAL NOT NULL, per_f REAL NOT NULL,
  items TEXT,                     -- v2.2: 整锅食材克重 JSON {"rice":510,...}，锅位队列展示用
  meal_allocation TEXT            -- v2.6: 各餐次剩余份数 JSON；NULL = 未分包批次（旧数据态）
);
```
> v2.6 分包语义：`inventory.meal_allocation` 存的是**剩余份数**（随核销递减），非 NULL 时同样满足 **Σ 槽位 = portions**，与 `portions` 在同一事务内同步维护。`NULL`（未分包旧批次，份数可被任意餐次取用）与 `'{}'`（已分包但零份，非法态、服务端拒收）语义相反，**合并成一个值会让核销无法区分「旧批次可自由取用」与「新批次已分光」**，故必须可空且旧数据一律保持 NULL、绝不编造餐次归属。

### settings（key-value）
默认值（PRD 表 4-1）：`weight=90, height=175, age=30, sex='m', act=1.375, gap=750, proteinPer=1.5, fatRatio=23, manualTdee=null, addonsOn=true, current_recipe_id=1`
v2.1 R5 新增：`targetWeight=80, weeklyRate=0.5, weightTrack=false`
v2.6 有氧新增（T-114）：`restingHr=70` —— **静息心率，40–120 的整数**，是有氧消耗公式里唯一的个人参数（详见第 6 节）；官方 Excel 第 16 表只覆盖 60–80，字段放宽到 40–120 以容纳运动员与偏高人群。默认值同样在三处同步（`seed.js` `DEFAULT_SETTINGS`、`db.js` `ensureSettingsKeys()`、`constants.js` `SETTINGS_FALLBACK`），写入非整数或越界 → 400。
v2.6 配额模式新增 7 键（默认值须在 `backend/src/seed.js` 的 `DEFAULT_SETTINGS`、`backend/src/db.js` 的 `ensureSettingsKeys()`、`frontend/src/constants.js` 的 `SETTINGS_FALLBACK` **三处逐字一致**）：

| 键 | 取值枚举 / 范围 | 默认 | 语义 |
|---|---|---|---|
| `calcMode` | `'tdee'` \| `'quota'` | `'quota'` | 计算模式（T-122 起默认 `quota`）。非枚举值 → 400 |
| `phase` | `'gain'` \| `'cut'` | `'cut'` | 目标阶段，决定查配额表哪一半 |
| `dayType` | `'train'` \| `'rest'` \| `'none'` | `'none'` | 日类型（`none` = 居家不运动） |
| `trainSlot` | 7 值枚举（见下） | `'before_dinner'` | 力训时间点；`dayType !== 'train'` 时仍校验、仅被引擎忽略（值保留，切回训练日即恢复） |
| `carbStage` | `'early'` \| `'late'` | `'early'` | 减脂碳水递减档位（初期 / 末期） |
| `carbPer` | `null` \| `1.0–6.0`（1 位小数） | `null` | 碳水配额覆盖值（g/kg），`null` = 按配额表 + BMI 修正取值 |
| `fatPer` | `null` \| `0.3–1.5`（1 位小数） | `null` | 脂肪配额覆盖值（g/kg） |
| `mealSlotsOff` | 六餐名数组（`breakfast`/`lunch`/`pre`/`post`/`dinner`/`snack`），去重后不可全关 | `[]` | **T-126** 关闭的餐次：其碳水比例与蛋白脂肪份额按比例归一化给其余餐次（Σ 仍 = 100%、各餐合计仍 = 全天配额），今日页不再出现该餐次（关 `snack` 时连「晚加餐」卡一起隐藏） |
| `lastRecalcWeight` | `null` \| `30–200` | `null` | **T-126** 上次重算配额时的体重：「减脂每降 5 kg 提醒重算」的基准；`null` = 从未重算 → 退回首条体重记录 |

`trainSlot` 七值 = `breakfast_early` 早饭后练（早起版）/ `breakfast_late` 早饭后练（晚起版）/ `before_lunch` 午饭前练 / `after_lunch` 午饭后练 / `before_dinner` 晚饭前练 / `after_dinner` 晚饭后练 / `night` 夜里练。
`proteinPer` **是既有键**（不新增），配额模式复用；v2.6 补齐 1.2–2.2 范围校验；**T-126 起 `dayType` 降级为「默认日类型」**：当天在今日页登记过状态就按登记值算，没登记才用它（优先级见 v2.6 变更摘要）。
`mealSlotsOff` / `lastRecalcWeight`（T-126 新增）的范围与默认值同样在 `seed.js` / `db.js` / `constants.js` 三处同步：`mealSlotsOff` 元素必须落在六餐全集内、去重后不可全关（`mealSlotsOff 不能关闭全部餐次，至少保留一个`），`lastRecalcWeight` 必须为 `null` 或 30–200 的数字，违反 → 400。
取值优先级（逐项独立判断）：BMI 修正命中（`phase==='cut'` 且 BMI >28 / >32）时**蛋白与脂肪强制取修正值**（安全约束，不被 TDEE 模式存量值顶掉），碳水留 `carbPer` 覆盖口；未命中时三项分别取 `carbPer` / `proteinPer` / `fatPer`，空则取配额表区间下界。
模式切换时字段处置：`tdee` 模式下 `carbPer` / `fatPer` / `carbStage` / `phase` / `dayType` / `trainSlot` 保留在库、计算时忽略；`quota` 模式下 `act` / `gap` / `manualTdee` / `fatRatio` 同样保留在库、计算时忽略。两向切换均不删键、不清零。
- `gap` 前端钳制由 500–900 **放宽为 250–850**（覆盖 0.25/0.5/0.75 kg/周 → 275/550/825 kcal）。
- `weightTrack=true` 时：计算 BMR/TDEE 所用体重 = **最近一次 `weights.kg` 记录**（TDEE 随减重自动衰减），并展示“按最近体重滚动计算”提示；手动 TDEE 仍优先覆盖。
- 建议缺口换算 = `weeklyRate × 7700 ÷ 7`（±25 kcal 取整展示，不强制覆盖手填 gap，仅作参考读数）。

### day_logs（每日打卡）
```sql
CREATE TABLE day_logs (
  date TEXT PRIMARY KEY,          -- 'YYYY-MM-DD'
  meals REAL NOT NULL,            -- v2.6: 全部由备餐锅分包核销的份数之和，0–8 且最多 1 位小数（0.1 网格）
  whey INTEGER NOT NULL,          -- 蛋白粉勺数 0-6
  breakfast TEXT NOT NULL,        -- 加餐条目数组 JSON [{"id","g"}]（旧值字符串 id 由前端归一化）
  late TEXT NOT NULL,             -- 同上，晚加餐条目数组
  consumed REAL NOT NULL,         -- 已从库存扣减份数（FIFO 已消耗）
  per_snap TEXT,                  -- 打卡时每份营养快照 JSON {kcal,p,c,f}（旧口径兜底）
  batch_name TEXT,                -- 打卡时批次名，供回溯卡片展示
  meals_log TEXT,                 -- v2.2: 核销事件流 JSON [{ts,batchId,batchName,slot,portions,per:{kcal,p,c,f}}]
  satiety INTEGER NOT NULL DEFAULT 0, -- v2.2: 当日饱腹感 1-5，0=未记录
  checked_in INTEGER NOT NULL DEFAULT 0,  -- v2.4: 打卡确认标记 0=未确认(草稿) 1=已确认
  day_type TEXT,                  -- T-126: 当日登记的日类型 'train'|'rest'|'none'；NULL = 未登记（回退 settings.dayType）
  outing TEXT                     -- T-129: 当日外食/喝酒记录 JSON {type,level,baijiu,beer,slot}；NULL = 未登记
);
```
> v2.6 `meals` 三处口径：① 语义由「午饭 + 晚饭的正餐份数（0–4）」扩展为「**全部由备餐锅分包核销的份数之和**」（训练日最多 4 个可分餐次 × 每餐 ≤2 份 = 8）；② 列类型 `INTEGER` → `REAL`，允许 0.1 粒度（「份」是从锅里盛出的量，1.2 / 2.4 均合法；SQLite 亲和性本就能存小数，**旧库无需迁移**）；③ 后端校验为「0–8 的数值且最多 1 位小数」，落库前收到 0.1 网格。
> v2.6 `meals_log` 事件新增两字段：`slot`（可空，∈ `breakfast/lunch/pre/post/dinner`，旧事件保留 `null` 并在前端展示为「正餐（未指定餐次）」）与 `portions`（该事件承载的真实份数 —— 后端会把一笔小数份核销拆成 `ceil(take)` 条事件，**按事件条数计数会导致回撤多还/少还**，故回撤按 `Σ portions` 原路归还）。
> 旧数据迁移：库缺 `checked_in` 列时自动补列并按 `meals > 0` 回填为已打卡（旧口径下调不回补库存，`consumed` 可能高于 `meals`，故以 `meals` 为准）；备份导入遇缺失 `checkedIn` 键时同口径推断，避免二次扣库存。
> T-126 `day_type`：**当日登记的日类型**，`NULL` = 未登记。生效优先级 = 当日登记值 → `settings.dayType`（降级为「默认日类型」）→ `'none'`（`utils.pickDayType`）；只认 `train/rest/none` 三个枚举，脏值一律当未登记（`normDaylog` 同口径）。**「未登记」与「登记为 `none`」是两种语义**：前者回退设置里的默认值，后者是用户当天的明确表态。老库由幂等 `ALTER TABLE day_logs ADD COLUMN day_type TEXT` 补列（整列 `NULL` = 全部未登记，无需回填）；备份路径必须带上该字段（`BACKUP_COLUMNS.day_logs` 含 `day_type`，导入缺键时落 `null`）。
> T-129 `outing`：**当日外食/喝酒记录**，`NULL` = 未登记（删除记录即回到此态）。形状 `{type,level,baijiu,beer,slot}`：`type` ∈ `eat`/`drink`/`both`（必填，非法 → 400）；`level` ∈ `light`/`normal`/`big`（`type==='drink'` 时恒为 `null`，不参与折算）；`baijiu`（两，0–50）/ `beer`（瓶，0–30）在 `type==='eat'` 时恒为 0，落库前收到 0.1 网格；`slot` ∈ 六餐全集（缺省 `dinner`），决定「前后两餐」的锚点。折算口径与扣减算法（`utils.outingNutri` / `utils.adjustForOuting`）见 v2.6 变更摘要的 T-129 两条。老库由幂等 `ALTER TABLE day_logs ADD COLUMN outing TEXT` 补列（整列 `NULL` = 全部未登记，无需回填）；备份路径必须带上该字段（`BACKUP_COLUMNS.day_logs` 含 `outing`，导出为与 GET 同形的对象、导入缺键时落 `null`）。

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

### cardio_logs（有氧记录）
> T-114 新增（公式口径见第 6 节）。一天可有多条，故用自增 id 而非日期主键；**只存原始记录，不存派生消耗值**（改体重或静息心率后历史记录跟着重算）。完整列定义、NULL 语义与迁移方式见第 6.1 节。

### 种子数据（投产干净库）
- **写入**：34 种预设食材（与原型 mock.js FOODS 逐项一致，含语义 id 与 v2.6 的 `nature` 标注，判据见 seed.js 注释）、默认配方（name='一锅出', portions=6, items={rice:510,pork_loin:500,broccoli:400,carrot:400,corn:300,oil:60}，`meal_allocation` 默认 `{}` = 未分包）、settings 默认值（含 v2.6 七键与 `restingHr`）、空 rule_state 一行
- **不写入**：体重/打卡/库存演示数据（那是原型演示用途，投产后由用户真实产生；前端需处理空状态：今日页无库存时按当前配方每份营养估算、记录页不足 7 天显示"数据不足"）

## 3. API v2 契约（前缀 /api，响应 `{code:0,data}` / 错误 `{code:1,message}`）

| 方法+路径 | 说明 |
|---|---|
| GET /api/foods | 预设+自定义，按 category 顺序返回（含 `nature`） |
| POST /api/foods | 自定义食材（查重：同 category 同名拒绝；id 服务端生成）。**v2.6**：`nature` 可选，缺省/空串落 `'other'`，传了非法值 → 400 |
| DELETE /api/foods/:id | 仅允许删 is_preset=0 |
| GET /api/recipes | 配方库列表（含 items 解析、`mealAllocation` 与营养 totals）；GET /api/recipes/:id 取单条 |
| POST /api/recipes | 新建（配方体含 name/portions/items/locked/**mealAllocation**）；PUT /api/recipes/:id 更新（`mealAllocation` 未传时**保留原值**，与 `locked` 同构，避免旧客户端一次 PUT 清掉分包）；DELETE /api/recipes/:id 删除。`mealAllocation` 校验：键域 ⊆ breakfast/lunch/pre/post/dinner、值为 0.1 的整数倍、Σ = portions（容差 1e-6），违反 → 400 |
| GET /api/settings | 对象形式（数值已反序列化）；PUT /api/settings 部分更新（v2.6 新增 7 键与 `proteinPer` 范围校验，**T-126 新增 `mealSlotsOff` / `lastRecalcWeight` 两键**，非法枚举/越界 → 400；未知键仍 400 `未知设置项: <key>`） |
| GET /api/inventory | 库存列表（新→旧，只列 `portions > 0`） |
| POST /api/inventory | 批次登记 {name,portions,perKcal,perP,perC,perF,items?,mealAllocation?}，服务端生成 id/in_at；items 为整锅食材克重 JSON；**v2.6** `mealAllocation` 缺省/`null` → 落库 `NULL`（未分包，老客户端不受影响），给了则键域 + Σ = portions 校验 |
| POST /api/inventory/consume | FIFO 扣减 {portions, **mealSlot?**}，返回 {inventory,consumed,shortage,detail}；detail=实扣明细 [{batchId,batchName,mealSlot,fromUnassigned,per}]。**v2.4**：扣空的批次不再删除，`portions` 置 0 保留，供回撤归还。**v2.6** 按餐次隔离见下 |
| POST /api/inventory/restore | **v2.4** 回撤打卡 {items:[{batchId,portions,**mealSlot?**}]}，按批次把份数加回，返回 {inventory}；batchId 不存在时静默跳过（历史批次可能已删）。带 `mealSlot` 且批次已分包时同步回补该槽位余额，未分包批次只回补 `portions`（不编造餐次） |
| GET /api/day-logs | 全量（dict 形式 `{"2026-09-16":{...}}`），每行含 `dayType`（`'train'`\|`'rest'`\|`'none'`\|`null`，`null` = 未登记）与 **T-129 的 `outing`**（外食/喝酒记录对象，`null` = 未登记） |
| PUT /api/day-logs/:date | upsert 当日打卡。**v2.6**：`meals` 为 0–8 的数值且最多 1 位小数；`mealsLog[].slot` 可选但存在时必须 ∈ 可分包的五个餐次，否则 400。**T-126**：`dayType` 可选，缺省 / `null` / 空串 = 未登记（落 `NULL`），非空必须是 `train`/`rest`/`none`，否则 400 `dayType 只允许 train/rest/none 或留空`。**T-129**：`outing` 可选，缺省 / `null` = 未登记（落 `NULL`，即删除记录）；给了必须是对象，`type` 必须 ∈ `eat`/`drink`/`both`、`level` ∈ `light`/`normal`/`big`、`slot` ∈ 六餐全集、`baijiu` 0–50 / `beer` 0–30，否则 400（`outing.type 只允许 eat/drink/both` 等）；落库前按类型清零无关字段并收到 0.1 网格 |
| GET /api/weights | 列表（按日期升序） |
| POST /api/weights | upsert 当日体重 {kg}（同日覆盖） |
| GET /api/rule-state | {ignored,history}；PUT /api/rule-state 更新 |
| GET /api/cardio | **T-114** 有氧记录全量，按 `date ASC, id ASC`；行 → `{id,date,minutes,hr,form,createdAt}`（`hr` 可空 = 未填，按推荐 120 估算）。**不返回 kcal**（派生值由前端现算，见 6.3） |
| POST /api/cardio | **T-114** 新增一条 `{date,minutes,hr?,form?}` → 201 + 同一行形状（**不做按日 upsert**：早晚各一次是常态）。校验：`date` 必须 `YYYY-MM-DD`；`minutes` 正数且 ≤600（落库前收整到 0.1 网格）；`hr` 可空，给了必须是 60–220 整数；`form` 缺省落 `'other'`，给了必须 ∈ `walk/run/dance/other`。违反 → 400 |
| DELETE /api/cardio/:id | **T-114** 按 id 精确删除（不做"删当天全部"）；id 非正整数 → 400，记录不存在 → 404 |
| GET /api/backup | 全量导出 JSON（含 `__exportedAt`；recipes 带 `mealAllocation`、inventory 带 `mealAllocation`、day_logs 带 `checkedIn` / **T-126 的 `dayType`** / **T-129 的 `outing`**、foods 带 `nature`、**T-114 起含 `cardio_logs`**） |
| POST /api/backup | 导入 JSON，逐表「先清空再重灌」（单事务），返回 {touched}；`mealAllocation` / `checkedIn` / `dayType` / `outing` 缺失时按旧口径兜底（`'{}'` / `meals > 0` 推断 / `null` = 未登记 / `null` = 未登记），避免二次扣库存或外食记录丢失 |

**v2.6 `/api/inventory/consume` 的 `mealSlot` 扣减规则（四条）**：
1. `mealSlot` 缺省 / `null`：**完全沿用 v2.4 FIFO 行为**（只改 `portions`，`detail[].mealSlot = null`、`fromUnassigned = false`），老客户端不改也能用。该路径**不触碰已分包批次的 `meal_allocation`**，会让 Σ 槽位与 `portions` 脱钩 —— 属已知且刻意的向后兼容行为，**新 UI 每一笔核销都必须显式携带具体餐次**，不走此路径。
2. `mealSlot` 给定：只在 `meal_allocation` 非 NULL 且 `meal_allocation[mealSlot] > 0` 的批次里按 `rowid ASC` 扣，每扣一次在同一事务内**同步递减该槽位余额与 `portions`**（守住 Σ 不变量），`fromUnassigned = false`。
3. 已分包批次该餐次余额不足：继续扫 `meal_allocation IS NULL` 的未分包旧批次按 FIFO 扣，扣减只改 `portions`、**不写 `meal_allocation`**（不给旧数据编造餐次），`detail[].fromUnassigned = true`。
4. 仍不足：`shortage` = 剩余未扣份数，事务照常提交已扣部分。**不跨餐次借用** —— 分包的意义就是餐次隔离。
> 回撤必须与核销严格对称（否则重演 CALC-AUDIT §3.3 的「库存/记录分叉」事故）：带 `mealSlot` 且批次已分包 → 同步回补槽位与 `portions`；批次为 NULL → 只回补 `portions`；不带 `mealSlot` → 只回补 `portions`。

营养计算规则、统一错误处理、SPA fallback 与 v1 相同。

## 4. 前端五页规格（以原型为准，此处仅列功能锚点）

导航：底部 5 Tab —— 今日 / 配方 / 做饭 / 记录 / 设置。

1. **今日（F5/F7）**：正餐步进 **0–8（0.1 粒度，`Stepper` step=0.1、`fmtQty` 展示整数不带 `.0`）**、蛋白粉步进 0-6、早餐池（不吃/鸡蛋2个+牛奶250ml 300kcal P14C20F16/红薯150g/燕麦40g+牛奶250ml）、晚加餐池（不吃/红薯200g常态 122kcal/蛋白粉1勺 115kcal P24C2.1F1.5）、当日汇总 4 进度条+缺口读数、库存卡 FIFO 扣减（v2.4 起由「打卡」一次性触发，不再是 meals>consumed 差值驱动）、剩余≤2 份"该做饭了"提醒。每份营养参考：库存最新批次，无库存则当前配方每份。
   今日摄入 = per×meals + 勺×whey + 早餐 + 晚加餐（勺=114.9kcal P24 C2.1 F1.5）。
   **v2.4 一次性打卡（取代 v2.1 R1 逐份核销）**：正餐卡三态 —— ①**未录体重**：步进器可调 + 提示「先录今日体重，再回来打卡」，无打卡按钮；②**已录体重未打卡**：步进器可调 + 「✅ 今日打卡 · 确认 N 份」主按钮，点击后按份数一次性 `consume(N)`，返回的 `detail` 逐份写入 `meals_log`，`consumed` 与 `meals` 同步，`checked_in` 置 1 并锁定（步进器只读）；③**已打卡**：显示「已打卡 N 份」+「回撤」按钮，回撤按 `meals_log` 的 `batchId` 聚合份数调 `restore` 全额回补，清空 `meals_log`、`consumed` 归零、`checked_in` 置 0 并解锁。**份数与库存只在打卡这一个动作里同时变化，从结构上消除 consumed/meals 分叉。** 打卡后盘点被吃光的批次提示「🎉 锅X见底，吃了 N 天」。打开页面默认 0 份（依赖 DEFAULT_TODAY 归零），不存在预填虚记。
   **v2.2 R6/R7/R8 核销重构 + 成就感**（v2.4 起触发时机改为打卡）：事件式链路——按份数一次性 `consume(N)` 取实扣明细 `detail`，逐份追加进 `meals_log`（每份营养锁定在打卡时刻的批次），不再整体重拍快照（修复连点双扣与口径错位）。正餐卡改为「先入先吃」锅位队列（队首高亮 + 剩余份数 + 食材摘要 `items`）。页面头部新增 streak 🔥 徽章、今日 kcal 进度环（SVG 环形，达成度=摄入/目标）、饱腹感 1-5 星（再点同档取消）；某锅扣到 0 份时 toast「🎉 锅X见底，这一锅吃了N天」。
   **v2.6 各餐目标与按餐次核销**：正餐卡新增「各餐目标」区 —— 目标由 `mealTargets(当日生效日类型, settings.trainSlot, profile, mealStage, settings.mealSlotsOff)` 给出（**T-126：日类型取「当日登记值 → 默认值」的生效值 `store.todayDayType`**，`profile` 按 `calcMode` 在 TDEE 派 / 配额派之间择一），逐餐展示碳蛋脂目标与完成度；已关闭的餐次不再出现该行，卡底说明「已关闭 X：不显示、也不参与分配，其碳水比例与蛋白脂肪份额按比例归一化给其余餐次」。页面上方另有「**今日状态**」登记卡（未登记 / 力量训练 / 只做有氧 / 休息 四档，**「未登记」是显式选项** —— 单选框重复点同一项不触发 change，「再点一次取消」在部分浏览器会静默失效），登记即 `PUT /api/day-logs/:date` 落 `day_type`，只作用于当天。**「零食/夜宵」在口径上就是「晚加餐」机动卡的额度**：关闭 `snack` 时今日页整张「晚加餐」卡隐藏（不是留空壳；早餐是独立餐次，不受影响）。打卡时 `spreadPlan(total, weights)` 按各餐碳水比例把本次核销总份数摊到各餐（末位有权重的槽位吃余数），保证「Σ 各餐分配 = 本次核销份数」严格成立，每笔核销显式携带具体 `mealSlot`（**从不走 `mealSlot: null` 的兼容路径**，否则已分包批次的 Σ 槽位会与 `portions` 永久脱钩）。分包余量不足时由后端回退未分包旧批次（`detail[].fromUnassigned = true`），前端提示「本份来自未分包批次」。回撤按「批次 + 餐次」对称归还（份数按事件的 `Σ portions` 计，不按事件条数计）。
   **v2.6 食物性质提示（只提示不拦截）**：`FoodNatureNotice` 卡 —— 排除清单三类（高脂肉 / 糖油混合物 / 吸油菜）按「同一餐同一性质一条」聚合展示原话判据，**只提示不挡记录、不改克数、不做换算**；生熟重口径只对「干重」主食提示；「配餐引导」按原表四步（① 先搞定蛋白质 → ② 再看脂肪 → ③ 最后选碳水 → ④ 排除）折叠展示，默认收起。
2. **配方（F2/F3）**：搜索/分类筛选/自定义增删、自动搭配（算法见原型 verify-autogen.mjs：每餐目标=(目标−加项)/2，蔬菜均分150g、主食按剩余碳水、蛋白按剩余蛋白、油补脂肪缺口 5-15g；自然单位取整 NATURAL_UNITS）、每日预演红黄绿（|d|≤10% 绿 / ≤20% 黄 / >20% 红；红且未勾"我知道偏差"阻止保存）、缺口>900 提示过大、糙米替换 1/3 建议（配方含大米无糙米时）、配方库保存/载入/删除。
   **v2.5 结构化配方与目标导向微调**：左栏由「常驻食材库」改为「结构化配方」——按 `grain/protein/veg/fat`（及非空的 `custom`）分组，每组显示类别名、已选数量与「＋ 添加」；组内 `PickedRow` 行只提供 `− 克数 +`、锚定锁（🔒/🔓）与移除（×）。食材库改为按需弹层（默认筛选到被点类别），弹层内取消勾选即从配方移除；`FoodRow` 增加可选 `pickOnly`（默认 false，仅弹层使用，隐藏克数输入与锁定）。微调算法见 `utils.adjustFoodByStep(items, id, dir, foods, anchors, portions)`：一档 = 每份一个自然单位，同类内按**热量守恒**补偿其余未锚定食材，跨类克数不动；± 调过的食材自动进入 `store.recipe.locked`。右栏（自动搭配 / 一锅总量 / 份数 / 每份营养 / 每日预演 / 进入厨房）保持不变。
   加项（默认开）：**蛋白粉2勺 = 229.8kcal P48 C4.2 F3.0**（v2.1 R3 重定义，仅蛋白粉，无红薯）。
   **v2.1 R4 锁定**：已选食材行新增锁 toggle（🔒/🔓）；`autoGenerate` 改两阶段 —— 先对 `locked` 命中食材按现克数计入营养基数（克数不变），再对可变食材按扣除后的剩余目标分配；锁定蛋白已超目标时 toast 提示"锁定蛋白已近/超目标"，不产生负值。锁定状态随配方库持久化（`store.recipe.locked` ↔ recipes.locked，保存/载入都带）。做饭页称重清单对锁定食材标锁徽标。
   **v2.3 保存语义**：`store.recipe.id` 语义 = 当前绑定到的库条目，`null` = 未保存的新工作区。配方库操作行两个入口 —— 「**存配方**」绑定则 PUT 更新那条、未绑定则 POST 新建，按钮文案直接标出覆盖目标（`存配方·覆盖「X」`／`存为新配方`）；「**另存为**」仅在已绑定时出现，强制 POST 新建一条且不触碰原配方。`api.js` 提供 `createRecipe`（强制新建）/`updateRecipe`（更新指定条）/`saveRecipe`（按 id 自动择一，供 `goCook` 持久化工作区用），三者统一经 `recipeBody` 收发 `locked`。做饭页「清空重选」= 工作区 id 置空并清空，不落库。
   **v2.6 餐次分包设定**：右栏新增「餐次分包」区（可选，不填即整锅均分）—— 分包行 = 当日实际吃到的正餐段（按用餐先后）+ 已存下的其余槽位，可逐餐填份数；「一键按目标分配」按 `mealTargets` 的各餐碳水比例铺一版（练前/练后自动拿到更大份），与 `spreadPlan` 同构（**末项吃余数**，拼出的分包天然满足后端 Σ = portions 不变量）。**T-127**：本页 `mealTargets` 的入参必须与今日页 / 做饭页同源 —— 第 1 参取 `store.todayDayType`（当日生效的日类型），并透传 `settings.mealSlotsOff`；漏任一项都会让该页按设置里的静态日类型分包、或给已关闭的餐次分到份数（三页分餐比例与克数对不上账）。份数或份数步进变化时分包等比重摊；Σ ≠ portions 时给出阻断文案并**禁止保存/进厨房**（`flagBad` 与偏差拦截之外的第二道守卫）。关掉开关或「清空分包」→ `mealAllocation = {}`（整锅均分，不分餐次）。分包随配方持久化，`recipeBody` 必须收发 `mealAllocation`（**漏传会导致「保存即丢分包」**，整锅各餐碳水比例被静默改回均分）。
3. **做饭（F4）**：当前配方可称重清单、大字称重卡（点击→已称✓，再点撤销）、分装份数微调、批次登记入库（含每份 P/C/F）。
   **v2.1 R2 本锅详情**：done 阶段在"已入库"下方新增「本锅详情」卡 —— 食材清单（名称+克重+口径徽标+自然单位换算）、每份营养 tiles、每份生料重、分装份数；内存渲染自 `store.recipe`，不改表、不做历史回看。
   **v2.6 按餐次分装**：分装份数步进改 **0.1**（与配方页分包精度一致）；分装带各餐份数归属（`store.packAllocation`，默认继承配方的 `mealAllocation`，另有「按当日各餐比例切份」一键摊平，切份口径与 `spreadPlan` 同构），登记入库时随批次落库为该批次的 `mealAllocation`（缺省 / 合计为 0 → 不传，落库 `NULL` = 未分包批次）。**T-127**：本页「按各餐目标分配」用的 `mealTargets` 同样取 `store.todayDayType` + `settings.mealSlotsOff`，与今日页 / 配方页三页同源（否则会按静态日类型切份、并给已关闭的餐次分到份数）。
4. **记录（F6）**：体重录入（当日 upsert）、SVG 体重曲线+7日均线（`maAt` = 含当日的前 7 条均值；**v2.6 起仅曲线使用，规则引擎不再用它判定**）、规则引擎卡片（**v2.6 / T-112 重写**）：
   - **判定窗口 = 相邻两个等长 14 天窗口（T-126 起为「双窗均值」口径）**：锚点是**最后一条体重记录**（不是「今天」—— 用户可能几天没称，以今天为锚会把窗口内仅有的记录全切掉）；W1 = 近 14 天、W0 = 紧邻其前的 14 天（两窗边界按日期相减，既不相交也不留缝，否则某天会被算进两个窗口、均值被重复计一次），**变化率 =（W1 均值 − W0 均值）÷ W0 均值**。**行为变化：判定从此需要前后两窗各至少 1 条记录（约两周数据），原「取首末两条、首末跨度 ≥ 7 天 → 观察期」的门槛已取消**；W1 一条都没有 → 「数据不足」（none，引擎不运行）；W0 没有记录 → 「观察期」（observe —— 拿不到对比基准就不编结论）。取均值而非首末两点：每天脂肪分解仅 30–50 g，单日喝水 / 熬夜就能把首末两点整体带偏，均值对震荡序列更稳
   - **核心判据 = 朝目标方向的体重变化率 × 阶段阈值**（阈值留 0.05 个百分点容差：体重只记到 0.1kg、变化率是浮点除法，恰好 1% 会被算成 0.009999…）：
     - 增肌期：涨幅 ∈ +1%~+2% → 目标区间（ok）；> +2% → 涨得太多（warn，**减碳水**）；< +1% → 涨得不够（warn，**加碳水**）
     - 减脂期：跌幅 ∈ 2%~3% → 目标区间（ok）；跌 > 3% → 掉得太快（warn，**加碳水**）；跌 < 2%（含不掉秤 / 反涨）→ 掉得不够（warn，**减碳水**）
     - 动作方向必须按 `phase` 分开算：同一份变化幅度在增肌与减脂下对应的动作正好相反
   - **动作按 `calcMode` 分流**：配额模式 = **碳水 ±0.5 g/kg**（`stepCarbPer`，钳在 1.0–6.0；已到上下限时不给「一键应用」按钮，只给「已到界」文案 —— 点了不落库的按钮比没有按钮更糟）；TDEE 模式 = **每份大米干重 ±15 g**（整锅按份数等比）。两种模式都**只动碳水，蛋白与脂肪不动**
   - **两条提醒类规则**（安全 / 维护，优先于调碳水展示）：**停止减脂**（`stop_cut`：减脂期最新体重算出的 BMI 男 ≤23 / 女 ≤21，或空腹腰围男 >85cm / 女 >80cm → 建议转增肌期；腰围是可选输入，`settings` 无该键时整条不触发）；**重算配额**（`recompute`：基准优先取 **`settings.lastRecalcWeight`（上次重算配额时的体重，T-126 新增）**，缺省 / `null` 时退回首条体重记录；累计下降 ≥5 kg → 提示重算，**动作 `recalc_quota`** 把当前体重写回该键 —— 「提醒一次、记一次」，基准不动会让提醒一直挂着的旧问题由此消除；只在核心判据为「无需调整」时才顶上来，否则用户会漏掉该调的那一档碳水）
   - 卡片带 `window` / `windowText`：「判定口径：相邻两个 14 天窗口的体重均值 —— 近 14 天（区间 · N 条 · 均值 X kg）vs 前 14 天（…）」，两窗各几条、各自均值都摆出来，让结论建立在用户看得见的证据上；忽略 7 天存 `rule_state.ignored`（key 域：`insufficient` / `observe` / `stop_cut` / `recompute` / `carb_up` / `carb_down` / `plus15` / `minus15` / `carb_limit` / `in_range`），**动作域（`action`）新增 `recalc_quota`**（写回 `settings.lastRecalcWeight`）
   - 一键应用：配额模式写 `settings.carbPer`；TDEE 模式调当前配方大米克重，重命名为「原名·调整版」并保存
   - `checkinRate7`（近 7 天含今日 `meals > 0` 占比）保留但**不再是判定门槛**（他的口径里没有这一条），仅供后续纪律提醒复用
   **v2.2 历史饮食回溯增强**：每日回溯卡改为按 `meals_log` 聚合展示「吃了哪几锅各几份」（`summarizeMealsLog`），附碳蛋脂供能比条（`macroRatio`：蛋白 4/碳水 4/脂肪 9 kcal/g 折算占比）、饱腹感徽标（`satiety`）、以及头部「已达标 N/总天数」统计（达标 = |kcal−目标|≤10%，与 statusOf 绿档同口径）。旧数据（无 meals_log）回退按 `perSnap` 旧口径展示。
5. **设置（F1）**：体重/身高/年龄/性别/活动系数(1.2/1.375/1.46/1.55/1.725/1.9)/目标缺口；实时计算链 Mifflin-St Jeor：BMR=10w+6.25h−5a+5(男)/−161(女)，TDEE=BMR×act（manualTdee 非空则覆盖），目标=TDEE−gap，P=w×proteinPer，F=目标×fatRatio%/9，C=(目标−4P−9F)/4；高级：蛋白系数/脂肪供能比。
   **v2.1 R5 目标速率**：新增「减重目标」区 —— 目标体重 targetWeight、周减速率 weeklyRate（0.25/0.5/0.75 kg/周三档）、复选框 weightTrack「TDEE 跟随最近体重记录」。weightTrack on 时计算链的 bodyweight 取 weights 最近一条；下方展示动态参考读数"建议缺口 = weeklyRate×7700÷7 ≈ {get 的 kcal} kcal"（0.25→275 / 0.5→550 / 0.75→825）。JSON 导出（GET /api/backup 下载）/导入（POST /api/backup）。
   **v2.6 计算模式切换与配额区**：顶部「计算模式」单选（TDEE 派 / 配额派，顶部说明文案随之换口径）。配额派显示「配额模式（查 g/kg 表）」区 —— 目标阶段（增肌 / 减脂）、**默认日类型**（训练日 / 休息日 / 无训练；T-126 起标签改为「未登记今日状态时使用」—— 当天在今日页登记过状态就按登记值算）、力训时间点（7 值下拉，`dayType !== 'train'` 时禁用）、**餐次开关**（六餐 checkbox，高亮 = 会吃这一餐；关掉后当天不显示、其配额按比例分给其余餐次，去重后不可全关；旁注说明「关闭『零食/夜宵』后今日页不再显示该餐次的加餐卡」）、碳水递减档（初期 / 末期，非减脂期禁用）；读数区展示实际取用的三档 g/kg、对应克数、热量（派生值 = `4c+4p+9f`）与官方区间，并提供 **碳水 ±0.5 g/kg** 档位按钮（写 `carbPer`；另有「清空覆盖」回到按配额表 + BMI 修正取值）。BMI 命中修正档时显示「BMI xx 已超过 28/32，按官方修正接管蛋白与脂肪配额（碳水仍可调）」。切换模式只改 `calcMode`，两派参数都留在库、切回即完全恢复。身体参数（体重/身高/年龄）在配额派下必须保持可编辑 —— 配额派靠它们算 BMI 与克数（只有 `manualTdee` 非空时才锁 TDEE 派的身体参数）。

**v2.6 计算层**（纯计算，全部在 `frontend/src/utils.js` + `constants.js`，不依赖 Vue，可被 Node 断言脚本直接 import）：
- `calcProfile(settings, bodyWeight)` —— **TDEE 派，链路不变**；v2.6 仅修 CALC-AUDIT 的 D3：蛋白与热量统一乘同一体重口径（`bodyWeight`，缺省退回 `settings.weight`），杜绝「热量按最近体重、蛋白按设置体重」的双体重分叉。
- `calcQuotaProfile(settings, bodyWeight, dayType?)` —— **配额派（并行新增，与 TDEE 派互不影响）**：查 `QUOTA_TABLE[phase][sex][dayType]` + `BMI_ADJUST` → `{c, p, f, kcal, per, band, bmi, bmiAdjust}`；`kcal` 是派生展示值（`4c+4p+9f`）**不参与任何反推**；克数与 BMI 共用同一个 `bodyWeight`。**T-126 新增可选第 3 参 `dayType`**：传当日登记生效的日类型即覆盖 `settings.dayType`（缺失 / 脏值回退，两者都非法才落 `'none'`）。`stepCarbPer(cur, dir)` = 碳水 ±0.5 g/kg（钳 1.0–6.0）。覆盖值只在后端合法区间内生效，越界/非数字一律退回配额表取值，避免脏设置把 NaN 沿 `mealTargets` → 红黄绿门禁一路扩散。
- `pickDayType(reg, fallback)` —— **当日生效日类型（T-126）**：登记值优先、缺失 / 脏值回退 `settings.dayType`、两者都非法落 `'none'`。抽成纯函数让 `store.todayDayType` 与断言脚本共用同一口径，「日类型怎么取」全项目只有一处实现。
- `store.profile` 按 `settings.calcMode` 在两派之间择一，两派返回键名一致（`c/p/f/kcal`），下游 `previewState` / `recipeLib` / 规则卡无需分支。
- `mealTargets(dayType, trainSlot, quota, carbStage?, slotsOff?)` —— **分餐引擎**：纯分配函数（不接收 weight/sex/phase，那三项已被 `calcQuotaProfile` 消化）；`CARB_RATIO` 定碳水日内比例（训练日按 `trainSlot` 取 20/20/20/40，早饭兼练前餐时为 40%；休息日 / 无训练走 30/30/30/10，其中 `snack` 的 10% 是机动抵扣额度），`SLOT_ROLES` 定各餐角色并投影出 `preSlot` / `postSlot`。可选第 4 参 `carbStage='late'`（减脂末期）只换训练日的比例表为 `CARB_RATIO_LATE`（早饭 3 / 练前 2 / 练后 5 单位，其他餐碳水归零；`night` 档缺位练前餐的 2 单位并入练后餐），**缺省 / 脏值等价于初期表**（老调用点逐字节不变），休息日 / 无训练不受该参影响。**可选第 5 参 `slotsOff`（T-126）= `settings.mealSlotsOff`**：命中的餐次从当天结构整体移除，其碳水比例按比例归一化给其余餐次（÷ 剩余比例之和，故 `Σ carbRatio` 仍 = 1；蛋白与脂肪本就按餐次数均分，少一餐即按少一餐的总数重分，Σ 仍 = 全天配额）；三种脏输入一律退回原结构而不是硬算（非数组、过滤后一餐不剩、剩余比例之和为 0 —— 末期表里「其他餐」比例为 0，只留这些餐等于没有碳水可分），缺省 = 六餐全开。取整规则：前 N−1 项 `round1`、**末项吃余数**保证各餐相加精确等于全天配额；但**练后餐不参与吃余数**（余数可达 ±0.2g，落在它身上会顶破「蛋白 30–50g / 脂肪 ≤20g」硬约束），改由「最后一个**比例为正**的非练后餐」吸收（末期其他餐比例为 0，余数落上去会产出 ±0.1g 的非零甚至是负值）。非法日类型 / 训练时间点与脏配额一律收敛（退回无训练行 / 按 0 计），不抛错、不出负数或 NaN。**三处调用点（今日页 / 配方页 / 做饭页）必须传同一组入参**：第 1 参 = `store.todayDayType`（当日生效值）、第 5 参 = `settings.mealSlotsOff`（T-127 收口）。
- `evalRules(weights, portions, opts)` —— **规则引擎（重写）**：见上文 4. 记录；`opts.lastRecalcWeight`（T-126）为「上次重算配额时的体重」，缺省 / `null` 时重算提醒退回首条记录作基准，动作域新增 `recalc_quota`。
- `dailyPreview(per, addonsOn, allocation)` / `perMealTargets` —— 每日预演的**日总量恒为「每份 × `MEALS_PER_DAY`(2) + 加项」**，与是否分包无关：未分包即「每份 × 2 份正餐」；**分包（`mealAllocation` 非空）只把这 2 份按各餐比例拆到各餐**（`perMealIntake`：每天各餐份数 = 2 × 该餐份数 ÷ Σ 各餐份数，前 N−1 项取 0.1 网格、最大份额的餐次吃余数，使 Σ 各餐份数精确 = 2）。分包表达的是「这一锅的各餐比例」，**不是「一天的量」**（用户做好一锅放冰箱、每餐吃多少盛多少，一锅通常跨好几天；`autoGenerate` 按 `days × 2` 生成份数，两者同源自洽）。一锅天数 = `potDaysOf(portions)` = `⌈份数 ÷ 2⌉`，分包不改变它。各餐实际目标仍由 `mealTargets` 在今日页给出。
- 食物性质（`NATURES` / `EXCLUDE_NATURES` / `CAT_NATURE_DEFAULT`）与配餐引导（`MEAL_GUIDE`）是**提示层常量**，不进任何计算函数。

**验收断言**（脚本在 `verify/` 下，均可 `node verify/<name>.mjs` 直接跑；全绿退出码 0）：
- `calc-audit`（**89 项**，TDEE 派 + 三方对账）—— BMR 1849→TDEE 2542→目标 1792→宏量 135/46/210；NAS 实况（age 27 / 体重追踪 89）→ BMR 1854 / TDEE 2549 / 目标 1799 / P 134 · C 213 · F 46；默认配方 3715kcal/171.14P/521.09C/110.32F、每份 619.17kcal/28.52P；**v2.1 R3 重算**：每日预演（2 份 + 加项 229.8）= 1468.14kcal、缺口（TDEE − 预演）≈ 1074；默认搭配每餐蛋白目标 (135−48)/2 = 43.5g。**[L] 段守住预演口径不变量**：同一配方在分包（`{breakfast:1.2,lunch:1.2,pre:1.2,dinner:2.4}`）与未分包两种状态下，`dailyPreview` 的日总量**逐值严格相等**且红黄绿 `worst` 一致，分包只让各餐份数按比例变化（2 份 → 0.4/0.4/0.4/0.8）。
- `quota-audit`（**175 项**，配额派）—— 官方配额表 14 格逐格断言（减脂期男 70kg 训练日 `c=175 / p=105 / f=56`、休息日 `c=105`）；BMI 降配两档与取值优先级（BMI 29 男 → `per={carb:2.5, protein:1.2, fat:0.6}`、BMI 33 女 → `per={carb:1.7, protein:1.0, fat:0.5}`，蛋白/脂肪强制接管、只有碳水留覆盖口）；`carbPer` / `fatPer` 覆盖与 ±0.5 档位；`QUOTA_TABLE` / `CARB_RATIO` / `SLOT_ROLES` 自检（七条比例序列 Σ=1）；体重口径；（TDEE 派断言不回归由 `calc-audit` 守）。
- `meal-audit`（**453 项**，分餐引擎）—— 七种训练时间点逐档：餐序 / `preSlot` / `postSlot` / 单位制比例 / Σ 碳水·蛋白·脂肪 = 全天 / 练后餐 p≥30 且 f≤20；契约 §3.3 示例 A（175·105·56 → 35/25/14 ×3 + 70/30/14）、**§3.4 示例 B（315·135·90 → 碳水 63/63/63/126、蛋白 33.8/33.8/33.6/33.8、脂肪 23.3/23.3/23.4/20.0）**、§3.5 示例 C（105·105·56）；休息日与无训练逐字段同构；极小 / 零 / 极大 / 脏配额下不出负数与 NaN；返回结构、`constraints` 不共享引用、`roles` 与 `SLOT_ROLES` 同源。**末期档（`carbStage='late'`）**：七档逐条比例断言（早饭 3 / 练前 2 / 练后 5、其他餐碳水 0）、`night` 并入练后餐、Σ 恒等全天；缺省 / 脏 `carbStage` 与初期逐字段一致、休息日传 `late` 仍走均摊；末期下「0 比例餐次仍保留蛋白/脂肪目标」与余数只落比例为正的餐次。
- `rules-audit`（**123 项**，规则引擎）—— 两侧阶段阈值边界与「不调整区间」、两侧动作方向（增肌 / 减脂反向）、碳水 ±0.5 到界、稀疏称重（数据不足 / 观察期 / 双窗均值）、窗口结构与文案、停止减脂与重算配额两条提醒（含 `recalc_quota` 与 `lastRecalcWeight` 基准）、TDEE 模式「每份大米 ±15g」回归、脏输入。
- `cardio-audit`（**68 项**，有氧消耗与饮食置换；T-116 按官方表值重写）与 `backup-audit`（**30 项**，备份导出/导入往返，含 `cardio_logs` 与 day_logs 的 `dayType` / `outing`）—— 详见第 6.4 节。两者都是**独立新增**脚本，不进入上述四个脚本的计数。
- `food-fields-audit`（**65 项**，食物库 `gi` / `cookedWeight` 字段；T-120）—— 前后端枚举与提示口径一致性、旧库迁移 / 回填 / 幂等、预设食材逐条标注、自定义食材缺省与 400 校验、备份往返保全（项数随预设食材库扩充而增长）。同为独立脚本，不进入上述四个脚本的计数。
- `meal-slots-audit`（**338 项**，餐次开关 + 当日日类型生效优先级 + 餐次枚举同源；T-126 建、T-127 收口）—— [A] 关掉「零食/夜宵」后休息日 / 无训练 `30/30/30/10` 归一化为各 1/3、训练日关 snack 无操作；[B] 逐餐关闭 × 七种训练时间点守恒不变量（`Σ carbRatio` = 1、各餐三项之和 = 全天配额）、角色重算；[C] 全关 / 剩余比例为 0 / 非数组等脏输入一律退回原结构；[D] `pickDayType` 优先级与 `calcQuotaProfile` 的日类型覆盖；[E] 三处默认值同口径；**[F] 源码级断言 `MEAL_SLOTS` 只在 `helpers.js` 定义一次、settings 路由引用同一份、`PACK_SLOTS` 仍是不含 snack 的 5 席**。`meal-slots-audit` 同为独立脚本，不进入上述四个脚本的计数。
- `outing-audit`（**100 项**，外食/喝酒的折算与随餐修正；T-129）—— [A] 折算口径（1 两白酒 = 1 瓶啤酒 = 200 kcal / 50g 碳水、外食三档估算、`type` 决定取哪一部分）；[B] 归一化与脏输入一律落 `null` = 未登记；[C] 守恒不变量（一轮普通外食挂午饭 → 早饭/练前餐被压低，`Σ 各餐 = 全天配额 − 外食占用` 逐宏量严格成立；七档训练时间点遍历）；[D] 已超边界（外食折算量超过全天配额时扣到 0、无负数、给出「今天已超 X kcal」）；[E] 删除记录后各餐目标逐值回落、未登记时行为逐字段不变；[F] 源码级一致性（前后端 `OUTING_TYPES` / `OUTING_LEVELS` 逐值同源、`ALTER TABLE day_logs ADD COLUMN outing TEXT` 幂等迁移、备份白名单含 `outing`）。同为独立脚本。

## 5. 质量要求（不变）

- 注释中文讲"为什么"；函数≤50 行；async 必 try/catch；不留 TODO
- 前端不引 UI 库/图标库/axios/vue-router；图标可用内联 SVG 或 emoji
- Windows PowerShell 5 + Node 22 本地开发

## 6. 有氧模块（T-114 建；**T-116 修正公式为 ×6.4 − 6.2**）

> 定位：有氧**不是人人必做**，它的唯一作用是把消耗置换成"今天可以多吃的碳水量"，让减脂期不那么饿。
> 故界面先回答「你要不要做、做多少」（按体重分档），再谈记录与置换。
> 依据：`减脂方法论改造.md` §1.5 + 官方 Excel 第 16 表《有氧热量消耗》。

**与既有口径的交叉点（明确取舍，避免隐性双计）**：

| # | 问题 | 取舍 |
|---|---|---|
| ① | 有氧消耗是否进入 TDEE | **否**。活动系数 `act` 已含日常活动，再单独把有氧加进 TDEE 就是双计 |
| ② | 是否影响 `gap` / 目标热量 / 配额克数 | **否**。两个计算派（`calcProfile` / `calcQuotaProfile`）的入参完全不含有氧数据 |
| ③ | 是否进入规则引擎判据 / 建议动作 | **否**。第 4 节的判据仍只有「近 14 天体重变化率 × 阶段阈值 + 停止减脂 / 重算配额」 |
| ④ | 与 `day_logs` 打卡口径、`calcStreak` / 达标天数的关系 | **无关系**。有氧记录不发进 `day_logs`，不参与打卡与连续天数统计 |
| ⑤ | 提示层还是计算层 | **两者都不是**：它是**加法层** —— 唯一输出是「今日可多吃的碳水」，由 `store.profileWithCardio` 换算成 `4 kcal/g` 加到**今日页**的当日目标上（`settings` 的配额值一字不动）；**不进配方页红黄绿**（`previewState` / `recipeLib` 仍用未置换的 `profile`，否则"今天多做了一次有氧"会把配方库配色全部改掉） |

### 6.1 数据模型

**新表 `cardio_logs`**（一天可有多条，故用自增 id 而非以日期为主键）：

```sql
CREATE TABLE IF NOT EXISTS cardio_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,                  -- 'YYYY-MM-DD'，由前端传浏览器本地日期（容器跑 UTC，服务端自己的"今天"会差一天）
  minutes REAL NOT NULL,               -- 单次时长（分钟），落库前收整到 0.1 网格
  hr INTEGER,                          -- 运动心率（可选）；NULL = 未填，按推荐强度 120 估算
  form TEXT NOT NULL DEFAULT 'other',  -- walk/run/dance/other（与 seed.js 的 CARDIO_FORMS 逐值一致）
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
```

- **不存派生消耗值**：kcal 一律由前端按「公式 × 体重 × 小时」现算。相反的做法（打卡时把 kcal 快照进库）会让用户改了体重或静息心率后，历史记录永远停在旧参数算出的消耗上。
- **迁移**：全新表，老库启动时由 `CREATE TABLE IF NOT EXISTS` 幂等补建，没有历史 schema 需要改写，故 **不需要 `migrateXxxColumns()`**。
- **`form` 枚举**：`walk` 快走 / `run` 跑步 / `dance` 跳操 / `other` 其他（`other` 是容错值，不在枚举内的历史数据落这里）。前后端枚举必须逐值一致（前端 `cardio.js` `CARDIO_FORMS` ↔ 后端 `seed.js` `CARDIO_FORMS`），改一边必须同步另一边，否则新增记录会被后端 400 拦下。

**`settings.restingHr`**（静息心率，公式里唯一的个人参数）：**40–120 的整数，默认 70**（官方表覆盖 60–80，取中点作默认）。三处默认值已同步（`seed.js` `DEFAULT_SETTINGS` / `db.js` `ensureSettingsKeys()` / `constants.js` `SETTINGS_FALLBACK`）；写入非整数或越界 → 400 `restingHr 必须为 40–120 的整数`。它一改，全周记录的消耗与置换量立刻重算（这正是 kcal 不入库的原因）。

### 6.2 API

（契约表见第 3 节，此处只列要点）

| 路由 | 请求 / 响应 | 校验规则 |
|---|---|---|
| `GET /api/cardio` | → `[{id,date,minutes,hr,form,createdAt}]`，`ORDER BY date ASC, id ASC` | 无。**不返回 kcal**；`hr = null` 表示未填、按 120 估算 |
| `POST /api/cardio` | `{date,minutes,hr?,form?}` → 201 + 同一行形状 | `date` 必须 `YYYY-MM-DD`；`minutes` 正数且 ≤600；`hr` 可空，给了必须 60–220 的整数；`form` 缺省落 `other`，给了必须 ∈ 枚举。违反 → 400 |
| `DELETE /api/cardio/:id` | → `{ok:true}` | id 非正整数 → 400；记录不存在 → 404 |

- **不做按日 upsert**：早晚各一次有氧是常态，合并会丢失次数与时长明细。
- **不提供"删当天全部"**：误删一次就是一天记录全没了，只允许按 id 精确删除。
- 后端只做 CRUD，**不参与任何推导**（与项目既有分工一致：全部营养/消耗计算在前端）。

### 6.3 计算层（`frontend/src/cardio.js`，纯计算、不依赖 Vue，可被 Node 断言脚本直接 import）

**① 正确公式（T-116 修正）** —— 官方 Excel 第 16 表 B14 单元格原文：

```
每 kg 体重的活动热量消耗 = 活动心率 ÷ 静息心率 × 6.4 − 6.2
```

- 常量拆成自解释的两个：`HR_RATIO_FACTOR = 6.4`、`HR_RATIO_OFFSET = 6.2`，不把魔数藏在表达式里。
- 同表 F 列 `= ROUND($E14 × 体重, -1)`，即**每小时消耗（大卡）= 每 kg 值 × 体重**。
- **T-114 的历史错误**：曾把单元格文本截断读成「× 6」，会把消耗（及其置换出的碳水）算成实际的**约 2.5 倍**，直接吃掉减脂缺口。修正依据与表值对照：

| 静息心率 | 运动心率 | 表值（每 kg 每小时） | 公式值 | 旧 ×6 口径（错） |
|---|---|---|---|---|
| 60 | 120 / 140 / 170 | 6.59 / 8.72 / 11.92 | 6.60 / 8.73 / 11.93 | 12 / 14 / 17 |
| 70 | 120 / 140 / 170 | 4.76 / 6.59 / 9.33 | 4.77 / 6.60 / 9.34 | 10.29 / 12 / 14.57 |
| 80 | 120 | 3.38 | 3.40 | 9 |

  （表值只保留两位，公式值与表值差 0.01–0.02 属舍入，非口径分歧）

- **链路不变**：`cardioKcal = cardioPerKgHour(hr, rest) × 体重 × minutes / 60`。
- **非负钳制**：`活动心率 ≤ 静息心率` → 每 kg 值取 **0**。公式里的 `− 6.2` 已扣掉静息那部分基础代谢，活动心率没超过静息时结果会接近 0 甚至为负，而"负消耗"不存在（会反向扣掉饮食额度）。

**② 兜底**：
- 缺运动心率（`hr` 为 `null` / 空 / 非正）→ 按推荐强度 `CARDIO_HR_DEFAULT = 120` 估算，界面标注「估算」；
- 缺静息心率（`undefined` / 非正）→ 用 `CARDIO_REST_HR_DEFAULT = 70`；
- 体重 ≤ 0 / 时长 ≤ 0 / 记录为 `null` → 返回 0（不抛错，展示层不因脏数据白屏）。

**③ 周口径**：`weekStartKey(todayKey)` 取**自然周的周一**（全程本地日期推导，不碰 UTC，与 `day_logs` / `weights` 的日期口径同源）；本周窗口 = `[周一, 今天]`（只统计已发生的，不含未来）；`weekKcal = Σ 本周记录消耗`；`weekAvgKcal = weekKcal ÷ 7`（官方填表口径：一周消耗摊到每天）。

**④ 置换口径**：`carbBonus = round(weekAvgKcal × 25 / 100)` —— **每消耗 100 kcal 可多吃 ≈25 g 碳水**（官方第 16 表原文：100 大卡 ≈ 80 g 熟米饭）；`CARB_G_PER_100KCAL = 25`。今日可吃目标 = 原目标 + `4 × carbBonus` kcal（碳水 4 kcal/g），**只加在今日页，不进配方页红黄绿**。

**⑤ 分档建议** `cardioAdvice(phase, weight)`（他原文：增肌不做；减脂 >80 kg 不做；70–80 kg 先不做；<70 kg 每周 2 小时）：

| 条件 | `key` / `level` | 建议周时长 |
|---|---|---|
| 阶段 = 增肌 | `gain` / ok | 0（增肌期热量本就吃不满，有氧等于额外制造缺口） |
| 减脂 且 体重 > 80 kg | `over80` / ok | 0（体重越高基础代谢越高、能吃的量越大，越不需要腾饮食空间） |
| 减脂 且 70 ≤ 体重 ≤ 80 kg | `range7080` / observe | 0（先不加；配额吃满还常饿，再用有氧换一点碳水） |
| 减脂 且 体重 < 70 kg | `under70` / need | **120 分钟**（如每天 20 分钟 × 6 天，或 3 次 × 40 分钟） |
| 体重缺失 / 非法 | `unknown` / none | `null`（不猜档位，提示先填体重） |

**⑥ 强度与时机（只提示、不拦截任何操作）**：建议心率约 120 次/分（脂肪最大氧化的心率点，也容易坚持；强度再高脂肪供能占比反而下降）。时机四条 —— 力训前不做有氧 / 力训后有氧一般 ≤30 分钟 / 超过 30 分钟的长有氧与力训隔开几小时或放休息日 / 不要饭后有氧。

### 6.4 验收断言

- `cardio-audit`（**68 项**，T-116 重写）—— [A] 按官方第 16 表表值精确断言 8 组心率组合（容差 0.025 覆盖表值两位舍入）与两个常量；[B] 单条消耗（体重与小数时长参与）；[C] 缺心率兜底、静息兜底、`活动心率 ≤ 静息心率 → 0`、全心率网格（静息 40–120 × 运动 60–220）无负值、各类脏值归 0；[D] 体重分档建议逐档含边界 70 / 80；[F] 自然周窗口、本周累计 / ÷7 日均 / 可多吃碳水、体重翻倍线性、空记录与脏输入。
- `backup-audit`（**26 项**）—— 备份链路含 `cardio_logs`：导出条数未丢、`hr` 的可空值未丢、时长与日期未丢、清库后为空。
- 上述四个既有脚本（`calc-audit` / `quota-audit` / `meal-audit` / `rules-audit`）**不因本次修正改动任何一个断言**：公式修正只动 `cardio.js`，不触碰 `utils.js` / `constants.js` 的既有计算。

### 6.5 备份

`cardio_logs` 已在备份**导出 / 导入白名单**内：`BACKUP_COLUMNS.cardio_logs = ['id','date','minutes','hr','form','created_at']`，导出成与 `GET /api/cardio` 一致的 camelCase（`createdAt`），导入时 `hr ?? null`、`form || 'other'` 与后端校验兜底同口径。启动自检 `auditBackupCoverage()` 会拿白名单与真实表结构对账 —— 表里出现白名单外的列即报警（这正是 `foods.nature` 与 `recipes.locked` 曾静默丢失的教训）。
