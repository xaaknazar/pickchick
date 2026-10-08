import {
  Backoffice,
  BACKOFFICE,
  grantBackoffice,
} from '../../packages/backoffice-core/dist/index.js';
import { FINANCE, Finance } from '../../packages/backoffice-core/dist/finance.js';
import { FinanceController } from '../../services/api/dist/finance-controller.js';
import {
  BackofficeController,
  BackofficeContentController,
} from '../../services/api/dist/backoffice-controller.js';
import { createRequire } from 'node:module';
import {
  CatalogAdmin,
  CATALOG_ADMIN,
  CATALOG_MEDIA,
  CatalogMedia,
  provisionCatalogManager,
} from '../../packages/catalog-admin/dist/index.js';
import {
  CatalogMediaController,
  useCatalogAssetBodyParser,
} from '../../services/api/dist/catalog-media-controller.js';
import { createHttpApplication, RESOURCE } from '@pickchick/platform';
import { CatalogAdminController } from '../../services/api/dist/catalog-admin-controller.js';
import { withSyncDatabases } from '../helpers/sync.mjs';
import { createBackofficeServer } from '../../apps/backoffice/server.mjs';
import { ApiError } from '../../apps/backoffice/dist/api.js';
const require = createRequire(new URL('../../services/api/package.json', import.meta.url));
const { Module } = require('@nestjs/common');
export const storage = () => {
  const map = new Map();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  };
};
/**
 * Real catalog/back-office API behind the operator proxy. `media` mounts the photo upload and
 * media routes (CATALOG_MEDIA_UPLOAD_ENABLED); `remoteStops` turns on back-office stop commands.
 */
export async function withCatalog(run, options = {}) {
  const { media = false, remoteStops = false, ...serverOptions } = options;
  await withSyncDatabases(async (context) => {
    const { cloud, org, branch } = context,
      service = new CatalogAdmin(cloud.pool, { enabled: true }),
      manager = await provisionCatalogManager(cloud.pool, {
        organization_id: org,
        name: 'Синтетический управляющий',
        branch_ids: [branch],
      });
    const backoffice = new Backoffice(cloud.pool, true, { remoteStopsEnabled: remoteStops });
    await grantBackoffice(cloud.pool, manager.actor_id, branch, 'manager');
    class CatalogModule {}
    Module({
      controllers: [
        CatalogAdminController,
        BackofficeController,
        BackofficeContentController,
        FinanceController,
        ...(media ? [CatalogMediaController] : []),
      ],
      providers: [
        ...(media
          ? [
              {
                provide: CATALOG_MEDIA,
                useValue: new CatalogMedia(cloud.pool, { enabled: true, mediaEnabled: true }),
              },
            ]
          : []),
        { provide: FINANCE, useValue: new Finance(cloud.pool, true) },
        { provide: CATALOG_ADMIN, useValue: service },
        { provide: BACKOFFICE, useValue: backoffice },
        {
          provide: RESOURCE,
          useValue: {
            config: cloud.config,
            admission: {
              intercept(_ctx, next) {
                return next.handle();
              },
            },
          },
        },
      ],
    })(CatalogModule);
    const app = await createHttpApplication(CatalogModule);
    if (media) useCatalogAssetBodyParser(app);
    await app.listen(0, '127.0.0.1');
    const upstream = await app.getUrl(),
      proxy = createBackofficeServer({ apiPort: Number(new URL(upstream).port), ...serverOptions });
    await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${proxy.address().port}`;
    const transport = async (path, token, options = {}) => {
      const response = await fetch(`${url}/v1/admin/catalog/${path}`, {
        method: options.method ?? 'GET',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      const value = await response.json();
      if (!response.ok) throw new ApiError(value.code, response.status);
      return value;
    };
    try {
      await run({ ...context, service, backoffice, manager, url, transport, upstream });
    } finally {
      await new Promise((resolve) => proxy.close(resolve));
      await app.close();
    }
  });
}
