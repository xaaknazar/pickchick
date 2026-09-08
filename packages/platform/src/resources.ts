import { Admission } from './admission.js';
import { createPool } from '@pickchick/database';
import type { DatabasePool } from '@pickchick/database';
import type { OnApplicationShutdown } from '@nestjs/common';
import { createClient } from 'redis';
import type { Readiness } from '@pickchick/contracts';
import type { ServiceConfig } from './config.js';

export const RESOURCE = Symbol('PICKCHICK_RESOURCES');

export class Resources implements OnApplicationShutdown {
  readonly pool: DatabasePool;
  readonly admission: Admission;
  private readinessPending: Promise<Readiness> | undefined;

  constructor(readonly config: ServiceConfig) {
    this.pool = createPool(config.databaseUrl, config.databasePoolMax);
    this.admission = new Admission(config.httpMaxInFlight);
  }

  readiness(): Promise<Readiness> {
    // Concurrent probes share one bounded check. Do not cache a previously
    // healthy result across probes: dependency failures must remain observable.
    if (!this.readinessPending) {
      this.readinessPending = this.checkReadiness().finally(() => {
        this.readinessPending = undefined;
      });
    }
    return this.readinessPending;
  }

  private async checkReadiness(): Promise<Readiness> {
    let database: 'up' | 'down' = 'down';
    let schema: 'up' | 'down' = 'down';
    try {
      await this.pool.query('SELECT 1');
      database = 'up';
      const scope = this.config.service === 'api' ? 'cloud' : 'edge';
      const version = scope === 'cloud' ? '003_cloud_menu_sync.sql' : '004_edge_local_orders.sql';
      const result = await this.pool.query(
        'SELECT 1 FROM schema_migrations WHERE scope = $1 AND version = $2',
        [scope, version],
      );
      if (result.rowCount === 1) {
        // Also verify the serving tables and branch binding, not only SELECT 1.
        if (scope === 'cloud') {
          await this.pool.query('SELECT branch_id FROM branch_menu_activations LIMIT 1');
          // Published catalog remains readable when its editor is disabled.
          const catalogVersion = await this.pool.query(
            'SELECT 1 FROM schema_migrations WHERE scope=$1 AND version=$2',
            ['cloud', '009_cloud_catalog_admin.sql'],
          );
          if (catalogVersion.rowCount !== 1) throw new Error('Catalog schema is unavailable');
          for (const table of ['catalog_publications', 'catalog_branch_heads'])
            await this.pool.query(`SELECT 1 FROM ${table} LIMIT 0`);
          if (this.config.catalogAdminEnabled)
            for (const table of [
              'catalog_managers',
              'catalog_manager_branches',
              'catalog_draft_versions',
              'catalog_audit',
              'catalog_command_receipts',
              'catalog_manager_audit',
            ])
              await this.pool.query(`SELECT 1 FROM ${table} LIMIT 0`);
          if (this.config.catalogAdminEnabled) {
            for (const table of ['catalog_managers', 'catalog_manager_branches'])
              await this.pool.query(`SELECT lock_anchor FROM ${table} LIMIT 0`);
          }
          if (this.config.backofficeEnabled) {
            const version = await this.pool.query(
              "SELECT 1 FROM schema_migrations WHERE version='017_cloud_backoffice.sql' AND scope='cloud'",
            );
            if (version.rowCount !== 1) throw new Error('Backoffice schema unavailable');
            for (const table of [
              'bo_records',
              'bo_audit',
              'bo_commands',
              'bo_stock_balances',
              'bo_stock_documents',
              'bo_stock_movements',
              'bo_publications',
              'bo_delivery_outbox',
              'bo_access_grants',
              'bo_order_recipes',
              'pos_order_sync_projection',
              'commerce_captures',
              'commerce_refund_effects',
              'cloud_fulfillment_projection',
            ])
              await this.pool.query(`SELECT 1 FROM ${table} LIMIT 0`);
            for (const table of [
              'bo_audit',
              'bo_commands',
              'bo_stock_documents',
              'bo_stock_movements',
              'bo_publications',
              'bo_delivery_outbox',
            ]) {
              const grant = await this.pool.query(
                "SELECT has_table_privilege(current_user,$1,'INSERT') ok",
                [table],
              );
              if (!grant.rows[0]?.ok) throw new Error('Backoffice write grant unavailable');
            }
          }
          if (this.config.testOrderFlowEnabled) {
            for (const migration of [
              '004_cloud_test_order_flow.sql',
              '005_cloud_test_modifier_task_titles.sql',
              '006_cloud_test_permanent_access.sql',
            ]) {
              const testVersion = await this.pool.query(
                'SELECT 1 FROM schema_migrations WHERE scope = $1 AND version = $2',
                ['cloud', migration],
              );
              if (testVersion.rowCount !== 1) throw new Error('TEST order schema is unavailable');
            }
            // Parsing these reads checks the actual serving tables and runtime
            // SELECT grants, without exposing or scanning synthetic order data.
            for (const table of [
              'test_flow_lock',
              'test_actors',
              'test_quotes',
              'test_orders',
              'test_kitchen_tasks',
              'test_command_results',
              'test_outbox',
            ]) {
              await this.pool.query(`SELECT 1 FROM ${table} LIMIT 0`);
            }
          }
          if (this.config.customerAuthEnabled) {
            for (const migration of [
              '007_cloud_customer_identity.sql',
              '013_cloud_identity_receipt_limits.sql',
            ]) {
              const identityVersion = await this.pool.query(
                'SELECT 1 FROM schema_migrations WHERE scope=$1 AND version=$2',
                ['cloud', migration],
              );
              if (identityVersion.rowCount !== 1)
                throw new Error('Customer identity schema is unavailable');
            }
            for (const table of [
              'identity_customers',
              'identity_sessions',
              'identity_refresh_receipts',
              'identity_otp_request_tombstones',
              'identity_otp_challenges',
              'identity_sms_daily_budget',
              'identity_consents',
              'identity_deletions',
            ]) {
              await this.pool.query(`SELECT 1 FROM ${table} LIMIT 0`);
            }
            await this.pool.query(
              'SELECT receipt_failed_attempts FROM identity_otp_challenges LIMIT 0',
            );
          }
          if (this.config.fulfillmentTransportEnabled) {
            for (const version of [
              '014_cloud_fulfillment_transport.sql',
              '015_cloud_unpaid_cancellation.sql',
            ]) {
              const transport = await this.pool.query(
                'SELECT 1 FROM schema_migrations WHERE scope=$1 AND version=$2',
                ['cloud', version],
              );
              if (transport.rowCount !== 1)
                throw new Error('Cloud fulfillment transport schema is unavailable');
            }
            for (const table of [
              'fulfillment_transport_bindings',
              'cloud_fulfillment_inbox',
              'cloud_fulfillment_versions',
              'cloud_fulfillment_projection',
              'cloud_fulfillment_observed_tasks',
              'cloud_fulfillment_task_versions',
              'commerce_cancellation_intents',
              'commerce_cancellation_results',
            ])
              await this.pool.query(`SELECT 1 FROM ${table} LIMIT 0`);
          }
          if (this.config.posOrderSyncEnabled) {
            const pos = await this.pool.query(
              'SELECT 1 FROM schema_migrations WHERE scope=$1 AND version=$2',
              ['cloud', '016_cloud_pos_order_sync.sql'],
            );
            if (pos.rowCount !== 1) throw new Error('POS sync schema unavailable');
            for (const table of [
              'pos_order_sync_bindings',
              'pos_order_sync_inbox',
              'pos_order_sync_projection',
            ])
              await this.pool.query(`SELECT 1 FROM ${table} LIMIT 0`);
          }
          schema = 'up';
        } else {
          const assigned = await this.pool.query('SELECT 1 FROM branch_config WHERE id = $1', [
            this.config.branchId,
          ]);
          await this.pool.query('SELECT branch_id FROM active_menu LIMIT 1');
          await this.pool.query('SELECT id FROM local_orders LIMIT 1');
          if (this.config.edgeFulfillmentEnabled) {
            const fulfillment = await this.pool.query(
              'SELECT 1 FROM schema_migrations WHERE scope=$1 AND version=$2',
              ['edge', '005_edge_fulfillment.sql'],
            );
            if (fulfillment.rowCount !== 1)
              throw new Error('Local fulfillment schema is unavailable');
            for (const table of [
              'fulfillment_config',
              'fulfillment_stations',
              'fulfillment_station_grants',
              'fulfillment_routing',
              'fulfillment_reservations',
              'fulfillment_tasks',
              'fulfillment_inbox',
              'fulfillment_commands',
              'fulfillment_outbox',
            ])
              await this.pool.query(`SELECT 1 FROM ${table} LIMIT 0`);
            const binding = await this.pool.query(
              'SELECT 1 FROM fulfillment_config c JOIN fulfillment_routing r ON r.branch_id=c.branch_id AND r.version=c.active_routing_version WHERE c.branch_id=$1 AND c.device_id=$2',
              [this.config.branchId, this.config.edgeDeviceId],
            );
            if (binding.rowCount !== 1) throw new Error('Local fulfillment binding is unavailable');
          }
          if (this.config.fulfillmentTransportEnabled) {
            for (const version of [
              '006_edge_fulfillment_transport.sql',
              '007_edge_release_results.sql',
            ]) {
              const transport = await this.pool.query(
                'SELECT 1 FROM schema_migrations WHERE scope=$1 AND version=$2',
                ['edge', version],
              );
              if (transport.rowCount !== 1)
                throw new Error('Edge fulfillment transport schema is unavailable');
            }
            await this.pool.query('SELECT branch_id FROM fulfillment_release_results LIMIT 0');
            await this.pool.query('SELECT branch_id FROM fulfillment_transport_state LIMIT 0');
            await this.pool.query('SELECT branch_id FROM fulfillment_transport_failures LIMIT 0');
            await this.pool.query(
              'SELECT branch_id FROM fulfillment_transport_reverse_failures LIMIT 0',
            );
          }
          if (this.config.posOrderSyncEnabled) {
            const pos = await this.pool.query(
              'SELECT 1 FROM schema_migrations WHERE scope=$1 AND version=$2',
              ['edge', '008_edge_pos_order_sync.sql'],
            );
            if (pos.rowCount !== 1) throw new Error('POS sync schema unavailable');
            const binding = await this.pool.query(
              'SELECT 1 FROM pos_order_sync_state WHERE branch_id=$1 AND device_id=$2',
              [this.config.branchId, this.config.edgeDeviceId],
            );
            if (binding.rowCount !== 1) throw new Error('POS sync binding unavailable');
          }
          if (assigned.rowCount === 1) schema = 'up';
        }
      }
    } catch {
      // Dependency details stay in the status enum; driver errors are not public.
    }
    const redis = this.config.redisUrl ? await redisHealth(this.config.redisUrl) : 'not_required';
    const ready = database === 'up' && schema === 'up';
    return {
      service: this.config.service,
      ready,
      degraded: !ready || redis === 'down',
      dependencies: { database, schema, redis },
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

async function redisHealth(url: string): Promise<'up' | 'down'> {
  // A bounded probe; a failed Redis connection must not keep the process alive.
  const client = createClient({
    url,
    socket: { connectTimeout: 500, reconnectStrategy: false },
    disableOfflineQueue: true,
  });
  client.on('error', () => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        await client.connect();
        return (await client.ping()) === 'PONG' ? ('up' as const) : ('down' as const);
      })(),
      new Promise<'down'>((resolve) => {
        timer = setTimeout(() => resolve('down'), 750);
      }),
    ]);
  } catch {
    return 'down';
  } finally {
    if (timer) clearTimeout(timer);
    if (client.isOpen) client.destroy();
  }
}
