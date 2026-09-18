import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './db.js'; // 副作用导入：启动即完成建表与种子数据初始化
import foodsRouter from './routes/foods.js';
import recipesRouter from './routes/recipes.js';
import settingsRouter from './routes/settings.js';
import inventoryRouter from './routes/inventory.js';
import dayLogsRouter from './routes/day-logs.js';
import weightsRouter from './routes/weights.js';
import cardioRouter from './routes/cardio.js';
import ruleStateRouter from './routes/rule-state.js';
import backupRouter from './routes/backup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// 备份导入是全量 JSON，默认 100kb 上限会在数据增长后误伤，放宽到 5mb
app.use(express.json({ limit: '5mb' }));

app.use('/api/foods', foodsRouter);
app.use('/api/recipes', recipesRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/inventory', inventoryRouter);
app.use('/api/day-logs', dayLogsRouter);
app.use('/api/weights', weightsRouter);
app.use('/api/cardio', cardioRouter);
app.use('/api/rule-state', ruleStateRouter);
app.use('/api/backup', backupRouter);

// /api 前缀下未命中的路径统一 404，保持错误格式一致
app.use('/api', (req, res) => {
  res.status(404).json({ code: 1, message: '接口不存在' });
});

// 静态托管前端构建产物；public 不存在时跳过（纯 API 开发模式）
const publicDir = path.join(__dirname, '../public');
const hasIndexHtml = fs.existsSync(path.join(publicDir, 'index.html'));
if (hasIndexHtml) {
  app.use(express.static(publicDir));
  // SPA 路由 fallback：非 /api 的 GET 一律回退到 index.html
  app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });
}

// 统一错误中间件：所有异常都转成 {code:1,message}
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ code: 1, message: err.message || '服务器内部错误' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`fitness-meal-prep backend listening on http://localhost:${port}`);
});
