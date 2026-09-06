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
          if (this.config.testOrderFlowEnabled) {
            const testVersion = await this.pool.query(
              'SELECT 1 FROM schema_migrations WHERE scope = $1 AND version = $2',
              ['cloud', '004_cloud_test_order_flow.sql'],
            );
            if (testVersion.rowCount !== 1) throw new Error('TEST order schema is unavailable');
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
          schema = 'up';
        } else {
          const assigned = await this.pool.query('SELECT 1 FROM branch_config WHERE id = $1', [
            this.config.branchId,
          ]);
          await this.pool.query('SELECT branch_id FROM active_menu LIMIT 1');
          await this.pool.query('SELECT id FROM local_orders LIMIT 1');
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
