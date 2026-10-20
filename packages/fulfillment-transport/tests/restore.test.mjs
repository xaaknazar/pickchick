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
 * A backup is restored (finding 6.4): the heartbeat revision is the transport attempt counter,
 * which the restore rolls back, while the cloud already stored revisions of the lost timeline.
 * The cloud keeps ignoring every lower revision, so branch availability goes stale and every app
 * and kiosk checkout fails AVAILABILITY_STALE until the counter catches up. The fence moves the
 * counter past the lost timeline like the producer sequences.
 */
test('a restored edge refreshes branch availability again after the fence (6.4)', () =>
  fixture(async (f) => {
    await f.tick();
    await f.tick();
    const live = await availability(f);
    assert.equal(live.fresh, true);
    assert.equal(BigInt(live.revision), await attempts(f));
    // The lost timeline kept beating after the backup was taken; then the cashier was down.
    await f.cloud.query(
      `UPDATE cloud_branch_availability SET revision=revision+5000,
       observed_at=clock_timestamp()-interval '1 minute' WHERE branch_id=$1`,
      [f.scope.branchId],
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
