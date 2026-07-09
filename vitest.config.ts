import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Mismo prefijo que vite.config.ts: expone `gameCoord` (además de `VITE_*`) a
  // import.meta.env, así los tests que leen TETRA_GAME_COORD ven el valor del `.env`.
  envPrefix: ['VITE_', 'gameCoord'],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
