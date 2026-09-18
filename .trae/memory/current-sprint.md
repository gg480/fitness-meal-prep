# Sprint 计划 — 对齐「好人松松」减脂方法论（阶段 0 / 1 / 2）

> 依据 `减脂方法论改造.md`（决策：脂肪走系数派；分餐走方案 B 按餐次分包）。
> 派发说明：Trae 按每任务 `subagent_skills` 自动加载 SKILL.md。所有实现必须对齐 `减脂方法论改造.md` 第一、二章的配额表与分餐规则。
> 上一版 Sprint（SPEC v2.1 R1–R5）已全部交付，本文件已替换。

## 依赖图

```
T-101 修 CALC-AUDIT D1/D2/D3 + gap 口径 ── 独立，可并行
T-102 数据契约（settings 键 / 配额表 / mealTargets / 分包形状）
    │
    ├── T-103 后端 settings 配额键 ──┐
    ├── T-104 前端配额引擎 ──────────┤（不同文件域，可并行）
    ├── T-106 后端 recipes/inventory 分包 + 迁移
    │
    └── T-105 设置页配额模式 UI（等 T-103 + T-104）
        T-107 mealTargets 引擎（等 T-104）
            │
            └── T-108 配方/做饭页分包 UI（等 T-106 + T-107）
                │
                └── T-109 按餐次核销与展示（等 T-106 + T-108）
                    │
                    └── T-110 断言验证 + build 关门
```

| 批次 | 任务 | 依赖 |
|---|---|---|
| 一批（并行） | T-101、T-102 | 无 |
| 二批（并行） | T-103、T-104、T-106 | T-102 契约冻结 |
| 三批 | T-105 | T-103 + T-104 |
| 三批（并行） | T-107 | T-104 |
| 四批 | T-108 | T-106 + T-107 |
| 五批 | T-109 | T-106 + T-108 |
| 关门 | T-110 | 全部 |

## 任务卡片

### T-101 修复已登记的三处计算缺陷
- **描述**：修 `frontend/src/utils.js` 中 `allocFat` 的油兜底（D1：未勾食用油仍强行加 5–15g 油，油不在食材库时 TypeError）、`allocGrain` 的主食重复计入碳水（D2：多主食共用同一 `cLeft` 互不扣减）、`calcProfile` 的体重口径不一致（D3：热量用最新体重 `w` 而蛋白用 `s.weight`）；同步统一 `SPEC.md` L101 与 `SettingsView.vue` `clampSettings` 的 gap 范围表述。
- **前置依赖**：无
- **subagent_skills**：[debugging-and-error-recovery, write-tests]
- **验收标准**：
  - Given 配方未勾选任何 fat 类食材 When autoGenerate Then 不注入油、不报错
  - Given 勾选两种主食 When autoGenerate Then 每餐碳水不超每餐目标
  - Given weightTrack 开启且最近体重 85kg When 计算配额 Then 蛋白克数与热量使用同一体重
  - Given 全量改动 When vite build Then 通过
- **预估工作量**：2h
- **可并行**：是（与 T-102）

### T-102 冻结配额模式与餐次分包的数据契约
- **描述**：产出并冻结四份契约：① `settings` 新增键（`calcMode`＝tdde/quota、`phase`＝gain/cut、`dayType`＝train/rest/none、`trainSlot`＝7 枚举、`carbPer/proteinPer/fatPer` 及覆盖值）；② 配额表常量结构（阶段 × 性别 × 日类型 → 三个 g/kg，含 BMI>28 / >32 修正）；③ `mealTargets()` 输入输出结构（日类型 + 训练时间点 → 各餐碳蛋脂目标）；④ `recipes.items` / `inventory` 的餐次分包数据形状与旧数据迁移策略。
- **前置依赖**：无
- **subagent_skills**：[api-design, api-and-interface-design, documentation-and-adrs, architecture-review]
- **验收标准**：
  - Given 契约文档完成 When 审查 Then 覆盖 settings 键、配额表、mealTargets、分包形状四部分且含请求/响应 schema
  - Given 契约冻结 When 派发 T-103/T-104/T-106 Then 三者无需再互相等待
- **预估工作量**：2h
- **可并行**：是（与 T-101）

### T-103 后端 settings 支持配额模式键
- **描述**：`backend/src/routes/settings.js` 白名单新增 T-102 定义的键并加校验（枚举值白名单、数值范围）；`backend/src/seed.js` 写默认值；保证未知键仍返回 400。
- **前置依赖**：T-102
- **subagent_skills**：[backend-dev-sop, db-migration]
- **验收标准**：
  - Given PUT 非法 calcMode When 保存 Then 400
  - Given GET /api/settings When 读取 Then 返回全部新键默认值
- **预估工作量**：2h
- **可并行**：是（与 T-104 / T-106）

### T-104 前端配额引擎与配额表常量
- **描述**：新增 `calcQuotaProfile(settings, bodyWeight)`，按官方配额表返回 `{c, p, f}` 三个克数；新增配额表常量（阶段 × 性别 × 日类型）；支持 BMI>28 / >32 修正与 ±0.5 g/kg 档位调整。保留 `calcProfile` 原样服务 TDEE 模式。
- **前置依赖**：T-102
- **subagent_skills**：[frontend-component, test-driven-development]
- **验收标准**：
  - Given 减脂期男 70kg 无修正 When 计算 Then 碳水 175–210g、蛋白 105g、脂肪 56g（2.5–3 / 1.5 / 0.8 g/kg）
  - Given 同用户 dayType=rest When 计算 Then 碳水降至 105–140g（1.5–2 g/kg）
  - Given BMI 29 减脂期男 When 计算 Then 起始碳水 2.5、蛋白 1.2、脂肪 0.6 g/kg
  - Given 全量改动 When vite build Then 通过
- **预估工作量**：3h
- **可并行**：是（与 T-103 / T-106）

### T-105 设置页配额模式 UI
- **描述**：`SettingsView.vue` 新增「计算模式」切换（TDEE / 配额）与「目标阶段」「日类型」「训练时间点」选择；配额模式下隐藏活动系数与缺口，改为展示碳水/蛋白/脂肪 g/kg 与考算出的克数，并提供 ±0.5 档位；切回 TDEE 模式行为不变。
- **前置依赖**：T-103、T-104
- **subagent_skills**：[frontend-component, web-design-guidelines]
- **验收标准**：
  - Given 切到配额模式 When 打开设置 Then 显示 g/kg 与克数、隐藏活动系数与缺口
  - Given 点击 ±0.5 档位 When 调整 Then 配额与克数同步变化并落库
  - Given 切回 TDEE 模式 When 查看 Then 原参数与计算结果不变
- **预估工作量**：3h
- **可并行**：否

### T-106 后端 recipes/inventory 支持餐次分包 + 迁移
- **描述**：按 T-102 契约扩展 `recipes` 与 `inventory` 以承载「餐次 → 克重」；旧扁平数据双读兼容或迁移；`/api/inventory/consume` 支持按餐次核销；`buildRecipe` 与 `calcRecipeTotals` 同步适配。
- **前置依赖**：T-102
- **subagent_skills**：[backend-dev-sop, db-migration, api-design]
- **验收标准**：
  - Given 旧库只有扁平 items When 启动 Then 可正常读取不报错
  - Given 新配方带 mealAllocation When 保存并回读 Then 结构一致
  - Given consume 指定餐次 When 核销 Then 只扣该餐次的份
- **预估工作量**：4h
- **可并行**：是（与 T-103 / T-104）

### T-107 mealTargets 引擎
- **描述**：新增 `mealTargets(dayType, trainSlot, quota)`，训练日产出 20/20/20/40（练后餐配蛋白 30–50g、脂肪 ≤20g），休息日与无训练产出均摊（四餐碳水约 30/30/30/10）；7 种训练时间点映射到正确餐序。
- **前置依赖**：T-102、T-104
- **subagent_skills**：[frontend-component, test-driven-development]
- **验收标准**：
  - Given dayType=train 且 trainSlot=晚饭前练 When 计算 Then 晚饭为练后餐且占碳水 40%
  - Given dayType=none When 计算 Then 四餐均摊且无练前/练后餐
  - Given 任一情形 When 求和 Then 各餐碳水相加 = 全天 100%
- **预估工作量**：3h
- **可并行**：是（与 T-105）

### T-108 配方页/做饭页按餐次分包 UI
- **描述**：`RecipeView.vue` / `CookView.vue` 支持按餐次设定克重与分包；今日页展示各餐目标并对齐；规则引擎/自动搭配的克数调整改为按餐次定向，避免破坏练后餐占比。
- **前置依赖**：T-106、T-107
- **subagent_skills**：[frontend-component, web-design-guidelines]
- **验收标准**：
  - Given 配方设定餐次分包 When 保存并重载 Then 分包结构保留
  - Given 今日页 When 查看 Then 各餐显示自己的碳蛋脂目标与完成度
  - Given 调整某一餐主食 When 操作 Then 其他餐次克重不变
- **预估工作量**：4h
- **可并行**：否

### T-109 按餐次核销与展示
- **描述**：今日页/记录页核销时选择餐次；当日汇总仍守恒；缺口行与达标徽标按餐次维度补全。
- **前置依赖**：T-106、T-108
- **subagent_skills**：[frontend-component, web-design-guidelines]
- **验收标准**：
  - Given 库存 ≥1 When 选择餐次核销 Then 该餐次记录 +1 且当日汇总同步
  - Given 全部餐次核销完 When 查看汇总 Then 与日目标对比正确
- **预估工作量**：3h
- **可并行**：否

### T-110 断言验证 + build 关门
- **描述**：为配额引擎与 mealTargets 写断言（对齐官方配额表全部取值）；`npm run build` 通过且产物落 `backend/public`；回归 SPEC v2.1 既有断言（BMR 1849→2542→1792→135/46/210、预演 1468 / 缺口 1074、每餐蛋白 43.5g）不回归。
- **前置依赖**：T-101 ~ T-109
- **subagent_skills**：[write-tests, code-review-and-quality, deploy-check]
- **验收标准**：
  - Given 全部实现 When 跑断言脚本 Then 全部 PASS
  - Given 全量改动 When vite build Then 成功且 backend/public 产物更新
  - Given 旧功能 When 回归 Then SPEC v2.1 断言全绿
- **预估工作量**：2h
- **可并行**：否

## 派发编排

- **一批同时派发**：T-101（前端 utils + 文档）、T-102（纯文档，不与 T-101 冲突）
- **T-102 契约冻结后二批并行派发**：T-103（后端 settings）、T-104（前端配额引擎）、T-106（后端分包）
- **三批**：T-105（等 T-103+T-104）、T-107（等 T-104）
- **四批**：T-108（等 T-106+T-107）
- **五批**：T-109（等 T-106+T-108）
- **关门**：T-110

> 依据 user_rules：非破坏性操作直接执行；soloagent 不允许直接开发 → T-101 ~ T-110 全部由 subagent 承载。

## 前置缺失（需补）

- `.trae/memory/architecture.md`、`.trae/memory/tech-debt.md`、`.trae/memory/handover.md` 三个文件不存在，本次拆解未能按 SOP 前置读取。
- `CALC-AUDIT.md` 与本 Sprint 的 T-101 直接相关，已作为输入。

## 实施前必须选定的口径（来自 `减脂方法论改造.md` 第七章）

以下三处官方材料自身矛盾，代码实现前必须二选一，否则会出现双写：

1. 休息日碳水：脚注「训练日 −0.5g」vs 专页绝对值（增肌 2.5–3 / 减脂 1.5–2）→ **建议取专页绝对值**
2. 减脂期其他餐碳水比例：页写 2242/3052 vs 口述 2:2:4:2→3:2:5 → **建议取口述的三餐比、其他餐趋 0**
3. GI 清单：口述「低 GI 只有藕粉和粉条」vs Excel 表另列燕麦麸/粉丝/意面为低 GI → **阶段 3 再定，本 Sprint 不涉及**

---

## 执行反馈（按完成顺序追加）

### T-101 完成
- D1/D2/D3 已修；额外做了 D4（gap 钳制由 500–900 改为 250–850 对齐 SPEC，属行为变更）。
- 连带改了 `verify/calc-audit.mjs` 的 NAS 断言期望值（D3 修复后必然变化）。
- 未收口项：`CALC-AUDIT.md` 台账仍写修复前口径，待 T-110 同步；`autoGenerate` 对「已勾选但不在食材库」的 id 仍会抛错（非 D1 范围）。

### T-102 完成
- 契约文档：`契约-配额模式与餐次分包.md`。**注意与 `减脂方法论改造.md` 的「方案 A/B」命名冲突**：改造md 的 A/B 指「只改提示层 vs 按餐次分包」，契约的 A/B 指「扁平 items + mealAllocation vs 嵌套改写」。两处含义不同，阅读时勿混。
- 契约把分包粒度冻结为**「餐次 → 份数」**（等份不同数量），不是「餐次 → 不同克重」。20/40 = 2 份 vs 4 份。
- 关键发现：`proteinPer` 是既有键；`meals` 上限 4 有四处硬编码；`dailyPreview` 写死「2 份正餐」，**T-106/T-109 不得早于 T-108 单独上线**，否则红黄绿门禁失真。

### T-103 完成
- 7 个新键 + `proteinPer` 范围校验落地，三处默认值同口径。
- 越界但合理：额外改了 `backend/src/db.js` 的 `ensureSettingsKeys()`——不补则现有库读不到新键。

### T-104 完成
- `calcQuotaProfile` + 配额表常量 + `stepCarbPer`；`verify/quota-audit.mjs` 164 项全绿；`calc-audit` 44 项未回归。
- 未收口项：**`store.js` 的 `profile` computed 仍只走 TDEE**（契约 §5 要求按 `calcMode` 择一）→ 已并入 T-105。
- 风险事件：`constants.js` 与 T-103 并行写时被截断，已由 T-104 修复并复验。**同文件并行写入是本 Sprint 已发生的实际事故**，后续任务须先读后改、只做增量。

### T-106 完成
- DB 加列（幂等 `ALTER TABLE`）+ 双读兼容，零数据回填；`consume` / `restore` 支持 `mealSlot`；`meals` 放宽 0–8（后端侧）。
- 越界但合理：额外改了 `backend/src/routes/backup.js`——不补则备份往返会静默丢失全部分包。
- 待 T-109 同步的前端四处：`TodayView.vue` 的 `MEAL_MAX` 与三处引用；`api.js` 的 `recipeBody` / `consumePortions` 需带 `mealAllocation` / `mealSlot`。
- 契约张力：不带 `mealSlot` 核销已分包批次会让 Σ槽位 ≠ portions，已按契约原文实现；建议 T-109 的 UI 始终传 `mealSlot`，T-110 把 Σ=portions 断言限定在按餐次路径。

### T-105 完成
- 设置页配额模式区 + `store.js` 的 `profile` 按 `calcMode` 择一（补上了 T-104 未收口的一项）。
- 手验发现并修一处隐患：体重/身高/年龄的 `:disabled` 原绑定 `manual`，会让已存 `manualTdee` 的用户切到配额模式后体重被锁死，而配额模式正靠体重算 BMI 与克数 → 改为 `manualLock`。

### T-107 完成
- `mealTargets` + `verify/meal-audit.mjs` 323 项；七档餐序逐档验证 Σ=100%。
- **登记偏差**：契约 §3.4 示例自相矛盾（照 §3.2 的「末项吃余数」复算，练后餐脂肪到 20.1g、蛋白 33.6g，与 §7.2 验收「p ≥ 30 且 f ≤ 20」冲突）。取舍为「硬约束优先」——练后餐不参与吃余数，余数由最后一个非练后餐吸收；与 §3.4 示例最多差 0.2g，§3.3/§3.5 逐字段精确复现。
- 备注：`breakfast_early` / `breakfast_late` 两档早饭身兼「早饭 2 + 练前 2」= 4 单位，其练前餐槽位实为 40% 而非 20%。

### T-108 完成
- 配方页/做饭页分包 UI + 今日页各餐目标；`CookView` 分装步进改 0.1。
- **修掉一处静默丢数据**：`api.js` 的 `recipeBody` 漏传 `mealAllocation`，规则引擎一次调整就会把 40% 的配方存成均分锅。
- 规则引擎选「按各餐份数等比摊」——整锅等比变动对各餐是同一乘数，练后餐占比天然不变；另加「Σ 脱钩就不发保存」的守卫。
- 已确认未改 `TodayView.vue` 的 `MEAL_MAX`（留给 T-109）。

### T-109 完成
- `MEAL_MAX` 4→8（单常量驱动四处，已 grep 确认无其他硬编码）；核销链路每笔显式带 `mealSlot`；撤回按「批次 + 餐次」对称归还；记录页带餐次。
- **登记偏差**：① 契约 §4.8 的 `"meals": 4.8` 跑不通，后端要求 0–8 整数 → UI 只允许整份核销，余量（如 0.4 份）留在批次里累计；② `meals_log` 事件新增 `portions` 字段（后端会把小数拆成多条事件，按条数计数会导致撤回多还/少还）；③ UI 刻意不走后端兼容的 `mealSlot: null` 路径——实验证明它会让已分包批次的 Σ槽位 与 portions 永久脱钩。

### T-110 完成（关门）
- 三个审计脚本：`calc-audit` 44/0、`quota-audit` 164/0、`meal-audit` 323/0；`npm run build` 成功，`backend/public` 产物干净无堆积。
- SPEC v2.1 既有断言全部复现、未回归；三处默认值（`seed.js` / `db.js ensureSettingsKeys` / `constants.js SETTINGS_FALLBACK`）逐字一致。
- 文档同步：`CALC-AUDIT.md` 台账按修复状态更新；`契约-配额模式与餐次分包.md` 追加「八、实现反馈与偏差登记」（原契约正文零改动）。

### T-111 完成（新增任务：支持小数份核销）
- **触发原因**：用户的实际用法是「做好一锅放冰箱、吃多少盛多少」，不是预先分成固定盒数——「份」不是物理饭盒而是盛出量，整数核销无法记录真实摄入。
- 后端 `meals` 校验改为「0–8 且最多 1 位小数」、列类型 `INTEGER`→`REAL`（SQLite 亲和性本就能存小数，旧库零迁移）；前端步进 0.1、展示走 `fmtQty`（整数不带 `.0`）、写入与读路径统一收 0.1 网格；跨批次小数扣减与余量判断全部加 `1e-9` 容差（否则会报出 `2.2e-16` 的假 `shortage` 与 0 份幽灵事件）。
- `meals` 的全部消费方（`backup.js`、打卡率、`normDaylog`、`mealsNutri`、`LogView` 等）已逐一排查，无整数假设残留；全仓无 `parseInt`/`Math.floor`/`=== 0` 作用于 `meals`。
- 验证：三个审计脚本 44/164/323 全绿 + build 通过 + 临时服务 42 项小数边界手验全 PASS。
- 注：该会话无浏览器工具，未做像素级点击，以真实模块断言 + 抽取真实 `spreadPlan` 源码求值替代。

### 遗留待跟进
1. ~~契约 §3.4 示例自相矛盾~~ **已订正**：数值改为 `f 23.3/23.3/23.4/20.0`、`p 33.8/33.8/33.6/33.8`（由实现实跑取得），余数改由「最后一个非练后餐」吸收；§8.4 同步更新。`verify/meal-audit.mjs` [C] 段仍留 ±0.2 容差，值既已确定，可后续收紧。
2. `SPEC.md` L109 仍记着历史 schema「`meals INTEGER 0-4`」，与 T-111 之后的 REAL 0–8 不一致，待统一时同步。
3. `backup.js` 的 `importWriters()` 超 50 行、`utils.js` 的 `summarizeMealsLog` 成死导出、`RecipeView`/`CookView` 的分配算法有重复——均为低风险，本轮以「最小改动」为优先未清理（用户已确认不做）。

---

## 第二轮迭代（阶段 3 及收口）执行记录

| 任务 | 内容 | 关键结果 |
|---|---|---|
| T-111 | 支持小数份核销 | `meals` 改 REAL 0–8；用户实际用法是「一锅放冰箱、吃多少盛多少」，整数核销无法记录 |
| T-112 | 规则引擎按他的口径重写 | 14 天周期；增肌 +1% / 减脂 −2% 判据；动作改为调碳水 g/kg；新增 `verify/rules-audit.mjs` |
| T-113 | 食物性质分类与排除清单 | `foods.nature` 13 值枚举 + 35 种预设标注；提示型不拦截 |
| T-114 | 有氧记录与置换模块 | 新表 `cardio_logs` + `settings.restingHr`；顺带补齐 `backup.js` 白名单（发现 `nature`、`locked` 两处静默丢数据） |
| T-115 | 文档与测试收尾 | SPEC v2.6；`meal-audit` 收紧 §3.4 容差为精确断言 |
| T-116 | **修正我读错的有氧公式** | Excel 原文是 `活动心率 ÷ 静息心率 × 6.4 − 6.2`，我 dump 单元格时被 42 字截断看成 `× 6`（差 2.5 倍）。已同步代码 / 报告 v2 / 改造文档 / 断言 |
| T-117 → T-118 | **推翻「一锅 = 一天」的错误假设** | T-117 误把「Σ 分包份数」当一天的量，一标分包门禁就 +120% 爆红。T-118 改为「分包只表达各餐比例，不改变一天吃多少」，并加断言锁死「分包前后日总量严格相等」 |
| T-119 | 契约与台账对齐 | 契约 §5/§6.4 旧口径修正、新增 §8.6；CALC-AUDIT 新增 R6；行号锚点改为「以函数名为准」 |
| T-120 | 补 `gi` 与 `cookedWeight` 字段 | GI 高/中/低 + 生熟重口径枚举；备份白名单同步；新增 `verify/food-fields-audit.mjs` |
| T-121 | 补 2 行遗漏 + 消契约分叉 | `RecipeView.submitCustomFood` 补 `gi`/`cookedWeight` 透传；契约删掉实现中不存在的 `bmiAdjust` 字段 |
| T-122 | 默认口径切配额派 + 末期比例 | `calcMode` 默认 `'tdee'` → `'quota'`（三处）；`CARB_RATIO_LATE` 末期 3:2:5、其他餐碳水归零；核实并**证伪**了「TDEE 大米动作破坏占比」的报告 |
| T-123 | 最终一致性修补 | `CookView` 漏传 `carbStage` 已补；SPEC 签名/默认值/项数对齐；契约补 §7.1 勘误与 §8.7 |

**最终回归网（7 个脚本，共 934 项断言，全绿）**：`calc-audit` 69 / `quota-audit` 175 / `meal-audit` 453 / `rules-audit` 97 / `cardio-audit` 68 / `backup-audit` 26 / `food-fields-audit` 46。`npm run build` 通过，产物无堆积。

**本轮的两次自我纠错值得记下**：
1. Excel 单元格文本被我自己的 dump 脚本截断（42 字符上限）导致公式读错，是子任务交叉核对表内数值时才暴露的——**读外部数据源时要校验「公式」与「表内数值」是否自洽**。
2. 「一锅 = 一天」是我在契约里定错的口径，直接从「Σ 份数 = 整锅份数」推导而来，忽略了用户「一锅吃多天」的真实用法——**数据层不变量不等于业务语义**。

**遗留（均已在决策台账登记，等用户回答）**：有氧置换只贯通今日页、两套算法源并存、`M=2`（每天吃几份）写死、腰围无处录入、打卡率门槛是否保留、4 项 GI 标注不确定。
