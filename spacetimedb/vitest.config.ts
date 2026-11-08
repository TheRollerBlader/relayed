import { spacetimedbModuleTestPlugin } from 'spacetimedb/server/test-utils/vitest';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [spacetimedbModuleTestPlugin()],
  test: {
    environment: 'node',
    include: ['src/module.test.ts', 'src/access.test.ts'],
  },
});
