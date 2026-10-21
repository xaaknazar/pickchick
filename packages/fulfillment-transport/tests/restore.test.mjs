import test from 'node:test';
import assert from 'node:assert/strict';
import { fenceRestoredEdge } from '@pickchick/menu-sync';
import { fixture } from './worker-fixture.mjs';

const GAP = 1_000_000_000n;
const availability = async (f) =>
  (
    await f.cloud.query(
      `SELECT revision::text, observed_at > clock_timestamp() - interval '5 seconds' AS fresh
       FROM cloud_branch_availability WHERE branch_id=$1`,
      [f.scope.branchId],
    )
  ).rows[0];
const attempts = async (f) =>
  BigInt(
    (
      await f.pool.query('SELECT attempts FROM fulfillment_transport_state WHERE branch_id=$1', [
        f.scope.branchId,
      ])
    ).rows[0].attempts,
  );

/**
 * A backup is restored (finding 6.4): the transport attempt counter is the heartbeat revision and
 * the restore rolls it back, while the cloud already stored revisions of the lost timeline; the
 * cloud ignores every lower revision, so branch availability would go stale and every app and
 * kiosk checkout fail AVAILABILITY_STALE.
 *
 * Integration 19.10: two lanes fixed this and both stay. ful (1.6) makes the revision follow the
 * clock (max(counter + 1, microseconds)), so a lost timeline that ended before now is passed by
 * the very next heartbeat. pos (6.4) fences a restored database: the counter moves forward by
 * the same 1 000 000 000 as the producer sequences, which also covers a lost timeline ahead of
 * the clock (for example a cashier clock that stepped back after the restore).
 */
test('a restored edge refreshes branch availability again after the fence (6.4)', () =>
  fixture(async (f) => {
    await f.tick();
    await f.tick();
    const live = await availability(f);
    assert.equal(live.fresh, true);
    assert.equal(BigInt(live.revision), await attempts(f));
    // The lost timeline kept beating after the backup was taken, until shortly before now.
    await f.cloud.query(
      `UPDATE cloud_branch_availability SET revision=revision+5000,
       observed_at=clock_timestamp()-interval '1 minute' WHERE branch_id=$1`,
      [f.scope.branchId],
    );
    const ended = BigInt((await availability(f)).revision);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await f.tick();
    assert.equal((await availability(f)).fresh, true, 'a clock revision passes an ended timeline');
    assert.ok(BigInt((await availability(f)).revision) > ended);

    // A lost timeline ahead of the clock: without the fence the heartbeat stays ignored.
    await f.cloud.query(
      `UPDATE cloud_branch_availability SET revision=revision+$2::bigint,
       observed_at=clock_timestamp()-interval '1 minute' WHERE branch_id=$1`,
      [f.scope.branchId, String(GAP / 2n)],
    );
    const lost = BigInt((await availability(f)).revision);
    await f.tick();
    assert.equal((await availability(f)).fresh, false, 'a rolled-back revision is ignored');
    assert.equal(BigInt((await availability(f)).revision), lost);

    assert.equal((await fenceRestoredEdge(f.pool)).state, 'current');
    await f.pool.query(
      `INSERT INTO edge_database_epochs(epoch,system_identifier,database_oid,reason,sequence_gap)
       SELECT max(epoch)+1, 1, 1, 'initial', 0 FROM edge_database_epochs`,
    );
    const before = await attempts(f);
    const fence = await fenceRestoredEdge(f.pool);
    assert.equal(fence.state, 'restore');
    assert.equal(await attempts(f), before + GAP);
    await f.tick();
    const after = await availability(f);
    assert.equal(after.fresh, true, 'the cloud accepts the heartbeat again');
    assert.ok(BigInt(after.revision) > lost);
    // Idempotent: a second check moves nothing.
    assert.equal((await fenceRestoredEdge(f.pool)).state, 'current');
    assert.equal(await attempts(f), before + GAP + 1n);
  }));
