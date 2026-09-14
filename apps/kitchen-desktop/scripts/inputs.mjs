export const modules = ['app', 'api', 'model', 'runtime', 'types'];
export const inputPaths = [
  ...modules.map((name) => `apps/kitchen/src/${name}.ts`),
  'apps/kitchen/src/index.html',
  'apps/kitchen/src/styles.css',
  'apps/kitchen/tsconfig.json',
  'apps/kitchen/server.mjs',
  'tsconfig.base.json',
  ...[
    'main.mjs',
    'security.mjs',
    'package.json',
    'package-lock.json',
    'electron-builder.yml',
    'tsconfig.renderer.json',
    'scripts/build.mjs',
    'scripts/inputs.mjs',
    'scripts/verify-package.mjs',
    'resources/config.example.json',
  ].map((name) => `apps/kitchen-desktop/${name}`),
  ...[
    'logo.png',
    'bg-blue.png',
    'fonts/golos-text-2f175b8fc40e.woff2',
    'fonts/golos-text-f8d71091110f.woff2',
    'fonts/montserrat-6438d7b8ea9c.woff2',
    'fonts/montserrat-0b00fbd6edcc.woff2',
  ].map((name) => `design/prototype/assets/mockup/${name}`),
].sort();
