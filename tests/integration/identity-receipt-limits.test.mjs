import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { migrate } from '@pickchick/database';
import {
  CustomerIdentity,
  CustomerIdentityError,
} from '../../packages/customer-identity/dist/index.js';
import { withSyncDatabases } from '../helpers/sync.mjs';

const matches = (code) => (error) => error instanceof CustomerIdentityError && error.code === code;
const differentCode = (code) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function fixture(run) {
  await withSyncDatabases(async ({ cloud }) => {
    const config = {
      enabled: true,
      consentVersion: 'receipt-fixture-v1',
      termsUrl: 'https://example.test/terms',
      privacyUrl: 'https://example.test/privacy',
      dailySmsBudget: 100,
      lookupKey: randomBytes(32),
      otpKey: randomBytes(32),
      piiKey: randomBytes(32),
      receiptKey: randomBytes(32),
    };
    let deliveredCode,
      sends = 0;
    const delivery = {
      provider: 'mobizon',
      async sendCode(input) {
        deliveredCode = input.code;
        sends++;
        return {
          kind: 'submitted',
          provider: 'mobizon',
          submission: 'accepted',
          messageId: '1',
          campaignId: '1',
        };
      },
    };
    const make = () => new CustomerIdentity(cloud.pool, config, delivery);
    const identity = make();
    const request = await identity.requestOtp(
      {
        phone: '+77010000001',
        delivery_consent: { privacy_version: config.consentVersion, accepted: true },
        device_id: '10000000-0000-4000-8000-000000000009',
        request_id: randomUUID(),
      },
      '192.0.2.9',
    );
    const verification = {
      challenge_id: request.challenge_id,
      code: deliveredCode,
      device_id: '10000000-0000-4000-8000-000000000009',
      request_id: randomUUID(),
      consents: {
        terms_version: config.consentVersion,
        privacy_version: config.consentVersion,
        marketing_opt_in: false,
      },
    };
    const counters = async () =>
      (
        await cloud.pool.query(
          'SELECT attempts,receipt_failed_attempts FROM identity_otp_challenges WHERE id=$1',
          [request.challenge_id],
        )
      ).rows[0];
    await run({
      pool: cloud.pool,
      identity,
      make,
      verification,
      counters,
      sends: () => sends,
      latestCode: () => deliveredCode,
    });
  });
}

test('migration adds a zero recovery counter without resetting a saved session, receipt, or fresh attempt count', async () =>
  fixture(async (ctx) => {
    const session = await ctx.identity.verifyOtp(ctx.verification);
    const before = (
      await ctx.pool.query(
        "SELECT to_jsonb(c)-'receipt_failed_attempts' AS snapshot FROM identity_otp_challenges c WHERE id=$1",
        [ctx.verification.challenge_id],
      )
    ).rows[0].snapshot;
    // Reconstruct the pre-013 table only inside this disposable schema, then execute the additive migration.
    await ctx.pool.query('ALTER TABLE identity_otp_challenges DROP COLUMN receipt_failed_attempts');
    await ctx.pool.query(
      await readFile(
        new URL('../../db/cloud/migrations/013_cloud_identity_receipt_limits.sql', import.meta.url),
        'utf8',
      ),
    );
    const after = (
      await ctx.pool.query(
        "SELECT to_jsonb(c)-'receipt_failed_attempts' AS snapshot,receipt_failed_attempts FROM identity_otp_challenges c WHERE id=$1",
        [ctx.verification.challenge_id],
      )
    ).rows[0];
    assert.equal(hash(before), hash(after.snapshot));
    assert.equal(after.receipt_failed_attempts, 0);
    assert.equal(hash(await ctx.make().verifyOtp(ctx.verification)), hash(session));
    for (const count of [-1, 6])
      await assert.rejects(
        ctx.pool.query(
          'UPDATE identity_otp_challenges SET receipt_failed_attempts=$1 WHERE id=$2',
          [count, ctx.verification.challenge_id],
        ),
        (error) => error.code === '23514',
      );
    await assert.rejects(
      ctx.pool.query(
        'UPDATE identity_otp_challenges SET receipt_failed_attempts=NULL WHERE id=$1',
        [ctx.verification.challenge_id],
      ),
      (error) => error.code === '23502',
    );
    assert.deepEqual(
      await migrate(
        ctx.pool,
        fileURLToPath(new URL('../../db/cloud/migrations/', import.meta.url)),
        'cloud',
      ),
      [],
    );
  }));

test('two retry typos followed by exact replay recover the same session across service restart without new SMS', async () =>
  fixture(async (ctx) => {
    const issued = await ctx.identity.verifyOtp(ctx.verification);
    const typo = { ...ctx.verification, code: differentCode(ctx.verification.code) };
    await assert.rejects(ctx.identity.verifyOtp(typo), matches('CONFLICT'));
    await assert.rejects(ctx.make().verifyOtp(typo), matches('CONFLICT'));
    assert.deepEqual(await ctx.counters(), { attempts: 1, receipt_failed_attempts: 2 });
    const replays = await Promise.all(
      Array.from({ length: 6 }, () => ctx.make().verifyOtp(ctx.verification)),
    );
    assert.ok(replays.every((result) => hash(result) === hash(issued)));
    assert.deepEqual(await ctx.counters(), { attempts: 1, receipt_failed_attempts: 2 });
    assert.equal(ctx.sends(), 1);
    assert.equal(
      (await ctx.pool.query('SELECT count(*) FROM identity_sessions')).rows[0].count,
      '1',
    );
  }));

test('fifth fresh OTP attempt can succeed and its lost response still replays with the independent recovery budget', async () =>
  fixture(async (ctx) => {
    for (let i = 0; i < 4; i++)
      await assert.rejects(
        ctx.identity.verifyOtp({
          ...ctx.verification,
          code: differentCode(ctx.verification.code),
        }),
        matches('UNAUTHORIZED'),
      );
    const issued = await ctx.identity.verifyOtp(ctx.verification);
    assert.deepEqual(await ctx.counters(), { attempts: 5, receipt_failed_attempts: 0 });
    assert.equal(hash(await ctx.make().verifyOtp(ctx.verification)), hash(issued));
    assert.deepEqual(await ctx.counters(), { attempts: 5, receipt_failed_attempts: 0 });
  }));

test('concurrent guesses with the original device/request consume at most five durable failures and then deny even the correct receipt', async () =>
  fixture(async (ctx) => {
    const issued = await ctx.identity.verifyOtp(ctx.verification);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        ctx.make().verifyOtp({
          ...ctx.verification,
          code: differentCode(ctx.verification.code),
        }),
      ),
    );
    assert.ok(
      results.every((result) => result.status === 'rejected' && matches('CONFLICT')(result.reason)),
    );
    assert.deepEqual(await ctx.counters(), { attempts: 1, receipt_failed_attempts: 5 });
    await assert.rejects(ctx.make().verifyOtp(ctx.verification), matches('CONFLICT'));
    assert.deepEqual(await ctx.counters(), { attempts: 1, receipt_failed_attempts: 5 });
    // Guessing blocks only recovery; it cannot revoke a session already stored by the legitimate device.
    assert.equal((await ctx.identity.me(issued.access_token)).customer.id, issued.customer.id);
    assert.equal(ctx.sends(), 1);
  }));

test('unknown device or changed original request UUID cannot burn another device recovery budget', async () =>
  fixture(async (ctx) => {
    const issued = await ctx.identity.verifyOtp(ctx.verification);
    for (let i = 0; i < 6; i++) {
      await assert.rejects(
        ctx.identity.verifyOtp({
          ...ctx.verification,
          device_id: randomUUID(),
          code: differentCode(ctx.verification.code),
        }),
        matches('UNAUTHORIZED'),
      );
      await assert.rejects(
        ctx.identity.verifyOtp({
          ...ctx.verification,
          request_id: randomUUID(),
          code: differentCode(ctx.verification.code),
        }),
        matches('CONFLICT'),
      );
    }
    assert.deepEqual(await ctx.counters(), { attempts: 1, receipt_failed_attempts: 0 });
    assert.equal(hash(await ctx.identity.verifyOtp(ctx.verification)), hash(issued));
  }));

test('changed accepted input spends a failure and exhausted recovery can be replaced only through a new valid OTP', async () =>
  fixture(async (ctx) => {
    const issued = await ctx.identity.verifyOtp(ctx.verification);
    for (let i = 0; i < 5; i++)
      await assert.rejects(
        ctx.identity.verifyOtp({
          ...ctx.verification,
          consents: { ...ctx.verification.consents, marketing_opt_in: true },
        }),
        matches('CONFLICT'),
      );
    assert.equal((await ctx.counters()).receipt_failed_attempts, 5);
    await ctx.pool.query(
      "UPDATE identity_otp_challenges SET created_at=created_at-interval '61 seconds' WHERE id=$1",
      [ctx.verification.challenge_id],
    );
    const request = await ctx.identity.requestOtp(
      {
        phone: '+77010000001',
        delivery_consent: {
          privacy_version: ctx.verification.consents.privacy_version,
          accepted: true,
        },
        device_id: ctx.verification.device_id,
        request_id: randomUUID(),
      },
      '192.0.2.9',
    );
    assert.notEqual(request.challenge_id, ctx.verification.challenge_id);
    assert.equal(ctx.sends(), 2);
    // The existing access is not deleted by requesting a replacement. Verification owns replacement/revocation.
    assert.equal((await ctx.identity.me(issued.access_token)).customer.id, issued.customer.id);
    const replacement = await ctx.identity.verifyOtp({
      ...ctx.verification,
      challenge_id: request.challenge_id,
      request_id: randomUUID(),
      code: ctx.latestCode(),
    });
    assert.notEqual(replacement.session_id, issued.session_id);
    assert.equal(replacement.customer.id, issued.customer.id);
    await assert.rejects(ctx.identity.me(issued.access_token), matches('UNAUTHORIZED'));
    await assert.rejects(ctx.identity.verifyOtp(ctx.verification), matches('CONFLICT'));
  }));
