# Sprint 计划 — SPEC v2.1 五项需求（R1–R5）

> 派生自 SPEC.md v2.1。项目：一锅出 · 备餐管理器（Vue3 + Express5 + better-sqlite3）。
> 派发说明：Trae 按每任务 `subagent_skills` 自动加载 SKILL.md。所有实现必须对齐 SPEC v2.1 与原型 `C:\Users\1\Documents\健身\meal-cook-prototype\`。

## 依赖图

```
R4 后端（recipes.locked + API）
    │
    └── R4 前端（锁定 toggle + autoGenerate 两阶段）── 独立，可并行 R3
R5 后端（settings 白名单 + 3 新键）── 独立
    │
    └── R5 前端（设置页目标速率区 + calcProfile weightTrack）
R3 前端（constants/utils 加项=蛋白粉2勺 + DEFAULT_TODAY 归零）── 独立，R1 依赖其归零约定
    │
    └── R1 前端（今日页核销按钮）
R2 前端（做饭 done 页本锅详情）── 独立
```

| 批次 | 任务 | 依赖 | 说明 |
|---|---|---|---|
| 一批（并行） | T-001 后端 locked + seed；T-003 R5 后端 | 无 | DB/API 变更 |
| 一批（并行） | T-002 R4 前端；T-004 R5 前端；T-005 R3 前端 | T-001/T-003 后端冻结契约 | 前端 |
| 二批 | T-006 R1 前端 | T-005 | 共享归零约定 |
| 二批 | T-007 R2 前端 | 无 | 独立并行 |
| 三批 | T-008 断言验证 + vite build | 全部 | 关门 |

## 任务卡片

### T-001 后端支持配方锁定（recipes.locked）
- **描述**：recipes 表新增 `locked TEXT NOT NULL DEFAULT '[]'`（JSON id 数组）；seed 的 CREATE TABLE 含该列；recipes 路由 GET/POST/PUT 接收并回传 `locked`（数组），body 校验 locked 须为数组且仅含 items 中存在的 id；buildRecipe 解析 locked。
- **前置依赖**：无
- **subagent_skills**：[backend-dev-sop, db-migration, api-design]
- **验收标准**：
  - Given 已有 recipes 表 When 查询整表 Then 返回含 locked 数组
  - Given POST {locked:[...]} When 保存 Then 回读 locked 一致；locked 含不存在食材 id 时 400
  - Given 旧库无 locked 列 When 启动 Then 自动补齐默认 '[]'（迁移）
- **预估工作量**：2h
- **可并行**：是（与 T-003）

### T-002 前端配方锁定 UI 与两阶段自动搭配
- **描述**：已选食材行加锁 toggle（🔒/🔓）；`store.recipe.locked` 贯穿保存/载入；utils.js `autoGenerate` 改两阶段——locked 食材克数计入基数、可变食材按剩余目标分配；锁定蛋白超目标 toast 提示；做饭称重清单标锁徽标。
- **前置依赖**：T-001（locked 字段契约）+ 现有 utils.autoGenerate 签名已知
- **subagent_skills**：[frontend-component, web-design-guidelines]
- **验收标准**：
  - Given 锁定虾仁500g When 生成搭配 Then 虾仁仍500g 且其蛋白先计入目标
  - Given 锁定蛋白已超目标 When 生成 Then toast 提示且无负克重
  - Given 保存配方 When 载入 Then 锁定状态保留
- **预估工作量**：3h
- **可并行**：是（与 T-004/T-005）

### T-003 后端 settings 支持 R5 三键
- **描述**：settings.js 白名单新增 `targetWeight`（数值 30–200）、`weeklyRate`（数值 0.25/0.5/0.75 白名单枚举）、`weightTrack`（布尔）；seed 默认值写入 80 / 0.5 / false；readAllSettings 返回全量。
- **前置依赖**：无
- **subagent_skills**：[backend-dev-sop, db-migration]
- **验收标准**：
  - Given PUT {weeklyRate:0.7} When 保存 Then 400（非允许枚举）
  - Given GET /api/settings When 读取 Then 返回含三新键默认值
- **预估工作量**：1.5h
- **可并行**：是（与 T-001）

### T-004 前端设置页目标速率区 + weightTrack 计算链
- **描述**：设置页新增「减重目标」区（目标体重、周减速率 0.25/0.5/0.75 三档、weightTrack 复选框 + 建议缺口读数 weeklyRate×7700÷7）；`calcProfile` 在 weightTrack 且非 manualTdee 时 bodyweight 取 weights 最近一条。
- **前置依赖**：T-003
- **subagent_skills**：[frontend-component, web-design-guidelines]
- **验收标准**：
  - Given weightTrack on、最近体重85 When 打开设置 Then TDEE≈2411（对齐 SPEC 断言）
  - Given weeklyRate 0.5 When 显示建议缺口 Then ≈550 kcal
- **预估工作量**：3h
- **可并行**：是

### T-005 前端默认加项重定义为蛋白粉 2 勺
- **描述**：constants.js `ADDONS` 改为 `{label:'蛋白粉2勺', kcal:229.8, p:48, c:4.2, f:3.0}`；`DEFAULT_TODAY` 归零 `{meals:0, whey:0, breakfast:[], late:[], consumed:0}`；utils.js `normDaylog` 兜底同步归零；校验 `perMealTargets` 每餐蛋白=(P−48)/2。
- **前置依赖**：无
- **subagent_skills**：[frontend-component, test-driven-development]
- **验收标准**：
  - Given addonsOn 默认 true When 预演 Then 预演=2×份+229.8、缺口=TDEE−预演（对齐 SPEC 断言 ≈1468/1074）
  - Given 新用户打开今日页 When 载入 Then meals=0 whey=0 late=[] 无预填虚记
- **预估工作量**：2h
- **可并行**：是（与 T-002/T-004）

### T-006 今日页「吃了 1 份 · 核销」按钮
- **描述**：TodayView 正餐卡新增核销主按钮 → meals+1 → consume 扣1 → perSnap/落库；按钮显示最近批次每份 kcal；步进器下调加提示"仅改记录、库存不自动回补"。
- **前置依赖**：T-005（默认归零约定）
- **subagent_skills**：[frontend-component, web-design-guidelines]
- **验收标准**：
  - Given 库存≥1 当点击核销 Then meals+1 且库存−1 且落库
  - Given 库存0 When 核销 Then 按最近配方估算并 toast
  - Given 步进下调 When 操作 Then 记录改变但库存不变 + 提示文案
- **预估工作量**：2h
- **可并行**：否（等 T-005）

### T-007 做饭完成页「本锅详情」卡
- **描述**：CookView done 阶段"已入库"下方新增本锅详情卡：食材（名称+克重+口径徽标+自然单位）、每份营养 tiles、每份生料重、分装份数；内存渲染自 store.recipe，不改表。
- **前置依赖**：无
- **subagent_skills**：[frontend-component, web-design-guidelines]
- **验收标准**：
  - Given 登记入库后进入 done When 查看 Then 显示完整本锅食材构成与每份营养
  - Given 分装份数调整 When done Then 每份营养按实际份数计
- **预估工作量**：2h
- **可并行**：是（与 T-006）

### T-008 断言验证 + vite build 关门
- **描述**：按 SPEC v2.1 验收断言重跑 verify-all 同构断言（BMR 1849→2542→1792→135/46/210；预演1468/缺口1074；每餐蛋白43.5g；R5 weightTrack 85kg→2411/1661）；`npm run build` 通过；产物落 backend/public；全量回归（记录页规则引擎 6/7=86% 不回归）。
- **前置依赖**：T-002,T-004,T-005,T-006,T-007
- **subagent_skills**：[write-tests, code-review-and-quality, deploy-check]
- **验收标准**：
  - Given 全部实现 When 跑断言脚本 Then 全部 PASS
  - Given 全量改动 When vite build Then 成功且 backend/public 产物更新
- **预估工作量**：2h
- **可并行**：否

## 派发编排
- 一批同时派发：T-001、T-003、T-005、T-007（无互斥，DB 与前端不同文件域）
- 一批后端冻结后再发：T-002（等 T-001）、T-004（等 T-003）
- 二批：T-006（等 T-005）
- 三批关门：T-008

> 依据 user_rules：非破坏性操作直接执行；soloagent 不允许直接开发 → 具 T-00x 全部由 subagent 承载。