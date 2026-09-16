import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { scryptSync } from 'node:crypto';
import { StaffLoginSchema } from '@pickchick/contracts';
import { makeStaffPasswordVerifier } from '@pickchick/local-orders';
import { readHiddenPassword } from '../../scripts/hidden-password.mjs';

test('staff verifiers use unique random salts, interoperable scrypt parameters and preserve whitespace', async () => {
  const password = ' Synthetic password 42 ';
  const one = await makeStaffPasswordVerifier(password),
    two = await makeStaffPasswordVerifier(password);
  assert.notEqual(one.salt, two.salt);
  assert.notEqual(one.verifier, two.verifier);
  assert.equal(
    one.verifier,
    scryptSync(password, Buffer.from(one.salt, 'hex'), 32, {
      N: 32768,
      r: 8,
      p: 3,
      maxmem: 64 * 1024 * 1024,
    }).toString('hex'),
  );
  assert.notEqual(
    one.verifier,
    scryptSync(password.trim(), Buffer.from(one.salt, 'hex'), 32, {
      N: 32768,
      r: 8,
      p: 3,
      maxmem: 64 * 1024 * 1024,
    }).toString('hex'),
  );
  await assert.rejects(
    makeStaffPasswordVerifier('too short'),
    (error) => error.code === 'INVALID_REQUEST',
  );
  await assert.rejects(
    makeStaffPasswordVerifier('x'.repeat(129)),
    (error) => error.code === 'INVALID_REQUEST',
  );
  const parsed = StaffLoginSchema.parse({
    login: ' Cashier.One ',
    password,
    terminal_id: '10000000-0000-4000-8000-000000000003',
  });
  assert.equal(parsed.login, 'cashier.one');
  assert.equal(parsed.password, password);
});

function terminal() {
  const input = new PassThrough(),
    output = new PassThrough();
  let printed = '';
  input.isTTY = output.isTTY = true;
  input.setRawMode = (raw) => {
    input.isRaw = raw;
  };
  output.on('data', (chunk) => {
    printed += chunk.toString();
  });
  return { input, output, printed: () => printed };
}
test('hidden password input never echoes typed or pasted text and restores terminal mode', async () => {
  const tty = terminal();
  const result = readHiddenPassword('Hidden: ', tty);
  tty.input.emit('keypress', 'Secret pasted value', {});
  tty.input.emit('keypress', '', { name: 'backspace' });
  tty.input.emit('keypress', '!', {});
  tty.input.emit('keypress', '', { name: 'return' });
  assert.equal(await result, 'Secret pasted valu!');
  assert.equal(tty.printed(), 'Hidden: \n');
  assert.equal(tty.input.isRaw, false);
  assert.equal(tty.input.listenerCount('keypress'), 0);
});
test('hidden password input refuses redirected stdin and restores raw mode on cancellation/overflow', async () => {
  await assert.rejects(
    readHiddenPassword('', { input: new PassThrough(), output: new PassThrough() }),
    /Interactive terminal required/,
  );
  for (const mode of ['cancel', 'overflow']) {
    const tty = terminal();
    const result = readHiddenPassword('Hidden: ', tty);
    if (mode === 'cancel') tty.input.emit('keypress', '', { ctrl: true, name: 'c' });
    else tty.input.emit('keypress', 's'.repeat(129), {});
    await assert.rejects(result, /cancelled/);
    assert.equal(tty.printed(), 'Hidden: \n');
    assert.equal(tty.input.isRaw, false);
  }
});
