# 一锅出 · 备餐管理器 (fitness-meal-prep)

移动端优先的健身备餐管理工具，部署于 NAS 家庭日常使用。

## 功能（五页架构）

- **今日** — 正餐/蛋白粉步进打卡、早餐与晚加餐选项池、当日四条宏量进度条与缺口读数、库存 FIFO 自动扣减、剩余 ≤2 份"该做饭了"提醒
- **配方** — 食材库搜索/分类/自定义增删、自动搭配（按自然单位取整：鸡蛋按个、油按勺）、每日预演红黄绿校验（±10% 黄 / ±20% 红阻止）、缺口过大提示、糙米替换 1/3 一键建议、配方库管理
- **做饭** — 大字称重清单（点击标记/再点撤销）、分装份数微调、批次登记入库（含每份全量营养）
- **记录** — SVG 体重曲线 + 7 日移动均线、规则引擎（掉秤偏快→加主食 / 平台期→减主食 / 纪律不足→先打卡 / 两周过快→强提示）、一键应用生成调整版配方、忽略 7 天
- **设置** — Mifflin-St Jeor 计算链实时预览（BMR→TDEE→目标热量→宏量）、手动 TDEE 覆盖、蛋白系数/脂肪供能比高级调节、JSON 全量备份导出/导入

首次启动自动写入 34 种预设食材与默认配方"一锅出"（6 份 · 3715 kcal · P171 C521 F110），体重/打卡/库存由真实使用产生。

## 架构

```
单 Docker 容器（node:22-alpine，257MB）
├── Express 5 + better-sqlite3   REST API（端口 3000）
├── Vue 3 + Vite                 前端五页 SPA（同源静态托管）
└── /app/data                    SQLite（卷挂载持久化）
```

## NAS 部署（日常投产）

镜像发布于 Docker Hub：`lrunningmjgoat/fitness-meal-prep`

**方式一：docker compose（推荐）**

在 NAS 上创建目录，放入 [docker-compose.yml](docker-compose.yml) 后执行：

```bash
docker compose up -d
```

**方式二：docker run**

```bash
docker run -d \
  --name mealprep \
  --restart unless-stopped \
  -p 3830:3000 \
  -v /volume1/docker/mealprep/data:/app/data \
  lrunningmjgoat/fitness-meal-prep:latest
```

浏览器访问 `http://<NAS_IP>:3830`。

> 更新版本：`docker compose pull && docker compose up -d`（数据保留在挂载目录）。

## 本地开发

```bash
# 终端1：后端（端口 3000）
cd backend && npm install && npm run dev

# 终端2：前端（Vite 热更新，/api 代理到 3000）
cd frontend && npm install && npm run dev
```

## 构建镜像

```bash
docker build -t lrunningmjgoat/fitness-meal-prep:latest .
docker push lrunningmjgoat/fitness-meal-prep:latest
```

多阶段构建：前端构建 → 后端依赖（better-sqlite3 musl 源码编译）→ 运行时镜像（不含编译工具链）。

## API 概览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST/DELETE | `/api/foods` | 食材库（预设+自定义） |
| GET/POST/PUT/DELETE | `/api/recipes` | 配方库 |
| GET/PUT | `/api/settings` | 设置（含计算参数） |
| GET/POST | `/api/inventory` | 库存批次登记 |
| POST | `/api/inventory/consume` | FIFO 扣减 |
| GET/PUT | `/api/day-logs/:date` | 每日打卡 |
| GET/POST | `/api/weights` | 体重记录（同日覆盖） |
| GET/PUT | `/api/rule-state` | 规则引擎忽略状态 |
| GET/POST | `/api/backup` | 全量导出 / 导入 |

完整规格见 [SPEC.md](SPEC.md)。
