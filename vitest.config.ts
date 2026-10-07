import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests import workspace packages from source, so they run without building first.
const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@tool/protocol': pkg('protocol'),
      '@tool/contract': pkg('contract'),
      '@tool/relay': pkg('relay'),
      '@tool/bridge': pkg('bridge'),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts'],
  },
});
