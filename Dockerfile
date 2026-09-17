# ---- 阶段1：构建前端 ----
FROM node:22-alpine AS fe-build
WORKDIR /build
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
# 用 --outDir 覆盖 vite.config.outDir(../backend/public)：Docker 阶段3依赖 /build/dist，
# 且镜像内无 backend 目录；本机构建仍落 backend/public，二者互不干扰
RUN npm run build -- --outDir dist

# ---- 阶段2：安装后端依赖 ----
# better-sqlite3 在 musl(alpine) 上无预编译产物，需要本地编译工具链
# 编译工具只存在于本阶段，运行时镜像不携带，保持体积最小
FROM node:22-alpine AS be-deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY backend/package*.json ./
RUN npm ci --omit=dev

# ---- 阶段3：运行时 ----
FROM node:22-alpine
# tzdata 是 TZ 环境变量生效的前提：alpine 默认不带时区库，
# 缺了它批次时间戳（in_at）会按 UTC 显示，与本地差 8 小时
RUN apk add --no-cache tzdata
# 容器默认 UTC：批次时间戳等展示型时间会差 8 小时，固定上海时区
ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    DATA_DIR=/app/data \
    PORT=3000
WORKDIR /app
COPY --from=be-deps /app/node_modules ./node_modules
COPY backend/ ./
COPY --from=fe-build /build/dist ./public
VOLUME /app/data
EXPOSE 3000
# 用只读 API 探测进程存活，SQLite 是嵌入式库无需额外依赖
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/foods > /dev/null || exit 1
CMD ["node", "src/index.js"]
