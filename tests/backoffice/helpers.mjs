import {
  Backoffice,
  BACKOFFICE,
  grantBackoffice,
} from '../../packages/backoffice-core/dist/index.js';
import { FINANCE, Finance } from '../../packages/backoffice-core/dist/finance.js';
import { FinanceController } from '../../services/api/dist/finance-controller.js';
import {
  RECONCILIATION,
  Reconciliation,
} from '../../packages/backoffice-core/dist/reconciliation.js';
import { ReconciliationController } from '../../services/api/dist/reconciliation-controller.js';
import { Workforce } from '../../packages/backoffice-core/dist/workforce-store.js';
import { WORKFORCE, WorkforceController } from '../../services/api/dist/workforce-controller.js';
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
import { encodeCatalogImage } from '../../services/api/dist/catalog-image-encoder.js';
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
 * media routes (CATALOG_MEDIA_UPLOAD_ENABLED); `remoteStops` turns on back-office stop commands;
 * `stationPlans` turns on station plan delivery to the cashier edge; `reconciliation` mounts the
 * daily payment reconciliation (BACKOFFICE_RECONCILIATION_ENABLED); `roles`, `stockV2` and
 * `salesReport` are the cutover flags BACKOFFICE_ROLES_ENABLED, BACKOFFICE_STOCK_V2_ENABLED and
 * BACKOFFICE_SALES_REPORT_ENABLED (CC-5, CC-6, CC-7). `workforce` mounts the schedule, time sheet
 * and payroll routes (WORKFORCE_ENABLED); `posDay` is lane bo-ui's BACKOFFICE_POS_DAY_ENABLED.
 * `cloudMigrationDirectory` runs the API on an older cloud schema (lane bo-ui: stock v2 without
 * cloud075 is the cloud lane's stock page). `supply` is lane bo-ui2's BACKOFFICE_SUPPLY_ENABLED
 * (it needs `stockV2`), `stockReports` its BACKOFFICE_STOCK_REPORTS_ENABLED (also with `stockV2`).
 */
export async function withCatalog(run, options = {}) {
  const {
    media = false,
    remoteStops = false,
    stationPlans = false,
    reconciliation = false,
    roles = false,
    stockV2 = false,
    salesReport = false,
    posDay = false,
    autoconsume = false,
    managerShifts = false,
    staffPositions = false,
    discounts = false,
    supply = false,
    stockReports = false,
    workforce = false,
    cloudMigrationDirectory,
    ...serverOptions
  } = options;
  await withSyncDatabases(
    async (context) => {
      const { cloud, org, branch } = context,
        service = new CatalogAdmin(cloud.pool, { enabled: true }),
        manager = await provisionCatalogManager(cloud.pool, {
          organization_id: org,
          name: 'Синтетический управляющий',
          branch_ids: [branch],
        });
      const backoffice = new Backoffice(cloud.pool, true, {
        remoteStopsEnabled: remoteStops,
        stationPlanDeliveryEnabled: stationPlans,
        ...(roles ? { rolesEnabled: true } : {}),
        ...(stockV2 ? { stockV2Enabled: true } : {}),
        ...(salesReport ? { salesReportEnabled: true } : {}),
        // Lane bo-ui «Касса» (BACKOFFICE_POS_DAY_ENABLED).
        ...(posDay ? { posDayEnabled: true } : {}),
        // Lane bo-ui step 5 (BACKOFFICE_STOCK_AUTOCONSUME_ENABLED).
        ...(autoconsume ? { stockAutoconsumeEnabled: true } : {}),
        // Lane bo-ui step 6 (BACKOFFICE_MANAGER_SHIFTS_ENABLED, BACKOFFICE_STAFF_POSITIONS_ENABLED).
        ...(managerShifts ? { managerShiftsEnabled: true } : {}),
        ...(staffPositions ? { staffPositionsEnabled: true } : {}),
        // Lane bo-ui step 7 (BACKOFFICE_DISCOUNTS_ENABLED).
        ...(discounts ? { discountsEnabled: true } : {}),
        // Lane bo-ui2 step 2 (BACKOFFICE_SUPPLY_ENABLED, with stock v2).
        ...(supply ? { supplyEnabled: true } : {}),
        // Lane bo-ui2 step 4 (BACKOFFICE_STOCK_REPORTS_ENABLED, with stock v2).
        ...(stockReports ? { stockReportsEnabled: true } : {}),
      });
      await grantBackoffice(cloud.pool, manager.actor_id, branch, 'manager');
      class CatalogModule {}
      Module({
        controllers: [
          CatalogAdminController,
          BackofficeController,
          BackofficeContentController,
          FinanceController,
          ...(reconciliation ? [ReconciliationController] : []),
          ...(workforce ? [WorkforceController] : []),
          ...(media ? [CatalogMediaController] : []),
        ],
        providers: [
          ...(media
            ? [
                {
                  provide: CATALOG_MEDIA,
                  useValue: new CatalogMedia(
                    cloud.pool,
                    { enabled: true, mediaEnabled: true },
                    encodeCatalogImage,
                  ),
                },
              ]
            : []),
          {
            provide: FINANCE,
            useValue: new Finance(cloud.pool, true, roles ? { rolesEnabled: true } : {}),
          },
          { provide: RECONCILIATION, useValue: new Reconciliation(cloud.pool, reconciliation) },
          ...(workforce
            ? [
                {
                  provide: WORKFORCE,
                  useValue: new Workforce(cloud.pool, true, roles ? { rolesEnabled: true } : {}),
                },
              ]
            : []),
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
        proxy = createBackofficeServer({
          apiPort: Number(new URL(upstream).port),
          ...serverOptions,
        });
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
    },
    cloudMigrationDirectory ? { cloudMigrationDirectory } : {},
  );
}
