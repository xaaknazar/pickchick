import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createPool, transaction } from '@pickchick/database';
import { loadConfig, localDatabaseUrl } from '@pickchick/platform';

const filename = fileURLToPath(import.meta.url);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

async function childScenario(scenario) {
  const url = localDatabaseUrl(process.env.DISCONNECT_DATABASE_URL, 'disconnect fixture');
  assert.match(
    new URL(url).searchParams.get('options'),
    /^-c search_path=disconnect_[a-f0-9]{32}$/,
  );
  const pool = createPool(url, scenario === 'concurrent' ? 2 : 1);
  const controller = createPool(url, 1);
  try {
    if (scenario === 'trigger') {
      await pool.query(`CREATE TABLE crash_target(id int);
        CREATE FUNCTION disconnect_own_backend() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_terminate_backend(pg_backend_pid()); RETURN NEW; END $$;
        CREATE TRIGGER disconnect_own_backend BEFORE INSERT ON crash_target
        FOR EACH ROW EXECUTE FUNCTION disconnect_own_backend()`);
      let lostPid;
      await assert.rejects(
        transaction(pool, async (client) => {
          lostPid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          await client.query("INSERT INTO effects VALUES('uncommitted')");
          await client.query('INSERT INTO crash_target VALUES(1)');
        }),
        (error) => error.code === '57P01',
      );
      const recoveredPid = await transaction(pool, async (client) => {
        await client.query("INSERT INTO effects VALUES('recovered')");
        return (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      });
      assert.notEqual(recoveredPid, lostPid);
      assert.deepEqual((await pool.query('SELECT id FROM effects')).rows, [{ id: 'recovered' }]);
    } else if (scenario === 'concurrent') {
      const ready = deferred(),
        finish = deferred();
      let lostPid;
      const survivor = transaction(pool, async (client) => {
        await client.query("INSERT INTO effects VALUES('survivor')");
        ready.resolve();
        await finish.promise;
      });
      await ready.promise;
      try {
        await assert.rejects(
          transaction(pool, async (client) => {
            lostPid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
            await client.query("INSERT INTO effects VALUES('uncommitted')");
            // Deliberately no active query when the socket dies. An end listener
            // does not intercept error events, so missing lease protection crashes this child.
            const ended = new Promise((resolve) => client.once('end', resolve));
            assert.equal(
              (await controller.query('SELECT pg_terminate_backend($1) AS killed', [lostPid]))
                .rows[0].killed,
              true,
            );
            await ended;
          }),
          (error) => error.code === '57P01',
        );
      } finally {
        finish.resolve();
        await survivor;
      }
      const recoveredPid = await transaction(pool, async (client) => {
        await client.query("INSERT INTO effects VALUES('recovered')");
        return (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      });
      assert.notEqual(recoveredPid, lostPid);
      assert.deepEqual((await pool.query('SELECT id FROM effects ORDER BY id')).rows, [
        { id: 'recovered' },
        { id: 'survivor' },
      ]);
    } else if (scenario === 'healthy') {
      const originalPid = (await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      for (let i = 0; i < 16; i++) {
        const businessError = new Error('synthetic business failure');
        await assert.rejects(
          transaction(pool, async (client) => {
            assert.equal(client.listenerCount('error'), 1);
            await client.query('INSERT INTO effects VALUES($1)', [String(i)]);
            if (i % 2) await client.query('SELECT 1/0');
            throw businessError;
          }),
          (error) => (i % 2 ? error.code === '22012' : error === businessError),
        );
        assert.equal(
          await transaction(pool, async (client) => {
            assert.equal(client.listenerCount('error'), 1);
            return (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          }),
          originalPid,
        );
      }
      assert.equal((await pool.query('SELECT count(*) AS n FROM effects')).rows[0].n, '0');
      const borrowed = await pool.connect();
      try {
        assert.equal(borrowed.listenerCount('error'), 0);
      } finally {
        borrowed.release();
      }
      assert.equal(pool.totalCount, 1);
      assert.equal(pool.idleCount, 1);
    } else if (scenario === 'idle') {
      const pid = (await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const messages = [];
      const originalLog = console.error;
      console.error = (...parts) => {
        messages.push(parts);
      };
      try {
        const errored = new Promise((resolve) => pool.once('error', resolve));
        assert.equal(
          (await controller.query('SELECT pg_terminate_backend($1) AS killed', [pid])).rows[0]
            .killed,
          true,
        );
        await errored;
        assert.deepEqual(messages, [[JSON.stringify({ event: 'database_pool_error' })]]);
        assert.notEqual((await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid, pid);
      } finally {
        console.error = originalLog;
      }
    } else throw new Error('Unknown fixture scenario');
  } finally {
    await pool.end();
    await controller.end();
  }
  console.log(JSON.stringify({ scenario, status: 'passed' }));
}

if (process.argv[2] === '--disconnect-child') {
  await childScenario(process.argv[3]).catch(() => {
    // No driver exception/connection details in parent TAP output.
    console.log(JSON.stringify({ scenario: process.argv[3], status: 'failed' }));
    process.exitCode = 1;
  });
} else {
  for (const [scenario, title] of [
    [
      'trigger',
      'backend termination inside trigger rejects, rolls back and replaces the client without crashing',
    ],
    [
      'concurrent',
      'disconnect between queries does not crash or roll back another concurrent transaction',
    ],
    [
      'healthy',
      'ordinary SQL/business rollback reuses the healthy client without accumulating listeners',
    ],
    ['idle', 'idle pool disconnect remains contained and logs no driver details'],
  ])
    test(title, async () => {
      const config = loadConfig('api');
      assert.ok(['local', 'test'].includes(config.environment));
      const controller = createPool(config.databaseUrl, 1);
      const schema = `disconnect_${randomUUID().replaceAll('-', '')}`;
      const url = new URL(config.databaseUrl);
      url.searchParams.set('options', `-c search_path=${schema}`);
      try {
        await controller.query(`CREATE SCHEMA ${schema}`);
        await controller.query(`CREATE TABLE ${schema}.effects(id text PRIMARY KEY)`);
        const result = spawnSync(process.execPath, [filename, '--disconnect-child', scenario], {
          env: { ...process.env, DISCONNECT_DATABASE_URL: url.href },
          encoding: 'utf8',
          timeout: 20000,
          maxBuffer: 1000000,
        });
        // Intentionally no uncaughtException handler in the child: a raw client
        // error fails this assertion while leaving the integration runner alive.
        const unhandledClientError = /Unhandled 'error' event/.test(result.stderr ?? '');
        assert.equal(
          result.status,
          0,
          `Isolated ${scenario} child did not survive (signal=${result.signal}, unhandledClientError=${unhandledClientError})`,
        );
        assert.equal(result.stderr.length, 0, 'Child emitted unexpected diagnostic output');
        assert.deepEqual(JSON.parse(result.stdout), { scenario, status: 'passed' });
      } finally {
        await controller.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await controller.end();
      }
    });
}
