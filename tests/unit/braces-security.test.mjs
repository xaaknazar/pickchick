import test from 'node:test';
import { verifyBracesPatch } from '../../scripts/braces-security.mjs';
test('installed braces patch rejects deep strings and ASTs while retaining normal expansion', () =>
  verifyBracesPatch());
