#!/usr/bin/env node
// Kiosk staff code (audit 19.10). Offline and interactive only: the code is typed twice on a
// hidden terminal prompt, never passed through argv, environment or a file. The output is the
// verifier line for the API environment (KIOSK_STAFF_PIN_VERIFIER); it does not contain the code
// and cannot be reversed into it. Build first: pnpm --filter @pickchick/commerce-core build.
import {
  createKioskStaffPinVerifier,
  KIOSK_STAFF_PIN,
} from '../packages/commerce-core/dist/kiosk-staff.js';
import { readHiddenPassword } from './hidden-password.mjs';

let code = '';
let repeat = '';
try {
  if (process.argv.length > 2) throw new Error('No arguments are accepted');
  code = await readHiddenPassword('New kiosk staff code (4-8 digits, hidden): ');
  repeat = await readHiddenPassword('Repeat the kiosk staff code (hidden): ');
  if (!KIOSK_STAFF_PIN.test(code) || code !== repeat) throw new Error('Code confirmation failed');
  if (
    /^(\d)\1+$/.test(code) ||
    '0123456789012345678'.includes(code) ||
    '9876543210987'.includes(code)
  )
    throw new Error('Choose a code that is not a repeated or sequential run of digits');
  const line = `KIOSK_STAFF_PIN_VERIFIER=${await createKioskStaffPinVerifier(code)}`;
  console.log(line);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Kiosk staff code was not created');
  process.exitCode = 1;
} finally {
  code = '';
  repeat = '';
}
