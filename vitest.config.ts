import { defineConfig } from 'vitest/config';
// test/setup.ts points HOME at a throwaway folder, so no test ever writes into a real ~/.constellate.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], testTimeout: 60000, pool: 'forks', setupFiles: ['test/setup.ts'] } });
