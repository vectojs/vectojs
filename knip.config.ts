import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  workspaces: {
    '.': {
      entry: [],
      project: ['**/*.{js,ts}']
    },
    'packages/*': {
      entry: ['src/index.{js,ts}'],
      project: ['src/**/*.{js,ts}']
    },
    'apps/*': {
      entry: ['main.js', 'src/main.{js,ts}', 'vite.config.ts'],
      project: ['**/*.{js,ts}']
    }
  },
  ignore: ['tmp/**', 'docs/**']
};

export default config;
