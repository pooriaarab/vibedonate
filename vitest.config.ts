import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The mesh integration test drives real UDP sockets via hyperswarm's
    // udx-native, which misbehaves inside worker_threads — run that file as a
    // child process (forks pool). Mirrors vibedating's vitest.config.ts.
    poolMatchGlobs: [['**/mesh.integration.test.ts', 'forks']],
  },
});
