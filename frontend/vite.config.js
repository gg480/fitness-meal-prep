import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  // 动作库动图（v3.2）为 .gif 静态资源：vite 默认 assetsInclude 不含该扩展名，
  // 不配置会在 import 动图时解析失败，这里显式纳入作为资源处理
  assetsInclude: ['**/*.gif'],
  server: {
    proxy: {
      // 开发时把 /api 转发到本地 Express，保持与生产同源部署一致的请求路径
      '/api': 'http://localhost:3000',
    },
  },
  build: {
    // SPEC 第 2 节：构建产物由 Express 静态托管，必须落到 backend/public（Express 只 serve 该目录）
    outDir: '../backend/public',
    // outDir 落在 frontend 根目录之外，Vite 出于安全默认不会在构建前清空它，
    // 导致每次构建只是新增一批带新哈希的产物、旧文件永久残留；
    // 显式开启后既避免本地目录持续膨胀，也避免 Dockerfile 的 COPY backend/ ./ 把废弃产物带进运行时镜像
    emptyOutDir: true,
  },
})
