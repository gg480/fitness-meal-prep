import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      // 开发时把 /api 转发到本地 Express，保持与生产同源部署一致的请求路径
      '/api': 'http://localhost:3000',
    },
  },
  build: {
    // SPEC 第 2 节：构建产物由 Express 静态托管，必须落到 backend/public（Express 只 serve 该目录）
    outDir: '../backend/public',
  },
})
