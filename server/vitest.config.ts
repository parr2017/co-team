import { defineConfig } from 'vitest/config';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

// keep test-written knowledge files out of the repository data dir
const kbDir = path.join(os.tmpdir(), 'coteam-test-kb');
fs.mkdirSync(kbDir, { recursive: true });

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // 15s 默认超时：git worktree/多轮 mock 用例在全量并行负载下踩默认 5s 边界随机超时
    // （单跑全过、每次全量随机不同文件中招，2026-09-17 统一放宽）
    testTimeout: 15_000,
    env: {
      COTEAM_KNOWLEDGE_DIR: kbDir,
    },
  },
});
