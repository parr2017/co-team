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
    env: {
      COTEAM_KNOWLEDGE_DIR: kbDir,
    },
  },
});
