import { defineConfig } from 'vitest/config';

// 只服务本地回归测试：不参与部署，不引入任何构建产物。
export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node',
    pool: 'threads',
    testTimeout: 20000,
    hookTimeout: 20000,
    reporters: ['default'],
  },
});
