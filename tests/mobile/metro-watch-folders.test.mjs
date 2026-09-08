import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { relative, isAbsolute } from 'node:path';

const require = createRequire(import.meta.url);
const config = require('../../apps/mobile/metro.config.js');

test('the live Metro file map includes the shared restaurant directory', () => {
  const location = fileURLToPath(
    new URL('../../config/restaurant-locations.json', import.meta.url),
  );
  assert.ok(existsSync(location));
  assert.ok(
    [config.projectRoot, ...config.watchFolders].some((folder) => {
      const path = relative(folder, location);
      return !isAbsolute(path) && path !== '..' && !path.startsWith('../');
    }),
    'Dev imports outside workspace packages must belong to a Metro watch folder',
  );
  assert.ok(config.resolver.sourceExts.includes('json'));
});
