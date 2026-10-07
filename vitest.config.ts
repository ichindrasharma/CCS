import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests import workspace packages from source, so they run without building first.
const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

const alias = {
  '@tool/protocol': pkg('protocol'),
  '@tool/contract': pkg('contract'),
  '@tool/relay': pkg('relay'),
  '@tool/bridge': pkg('bridge'),
  '@tool/cli': pkg('cli'),
};

export default defineConfig({
  test: {
    projects: [
      { resolve: { alias }, test: { name: 'unit', include: ['packages/*/src/**/*.test.ts'] } },
      // Runs the built CLI as real processes; `npm run test:e2e` builds first.
      { resolve: { alias }, test: { name: 'e2e', include: ['tests/e2e/**/*.test.ts'], testTimeout: 90_000, hookTimeout: 60_000 } },
    ],
  },
});
