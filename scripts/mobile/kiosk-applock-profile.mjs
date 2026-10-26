#!/usr/bin/env node
// Renders the PickChick Kiosk Single App Mode (AppLock) profile for supervised restaurant iPads
// from infra/ipad/pickchick-kiosk-applock.template.mobileconfig (stage 2, lane kln).
//
//   node scripts/mobile/kiosk-applock-profile.mjs --organization "<название организации>" \
//     [--out .local/ipad/pickchick-kiosk-applock.mobileconfig]
//
// Only the organization name and two fresh payload UUIDs are filled in; the kiosk bundle id and
// the AppLock options stay as reviewed in the template. The profile holds no password, Wi-Fi,
// certificate or API key. Steps and checks: docs/operations/ipad-kiosk-lockdown.md.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const KIOSK_BUNDLE_ID = 'kz.pickchick.kiosk';
export const PROFILE_TEMPLATE = fileURLToPath(
  new URL('../../infra/ipad/pickchick-kiosk-applock.template.mobileconfig', import.meta.url),
);
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DEFAULT_OUT = '.local/ipad/pickchick-kiosk-applock.mobileconfig';
const PLACEHOLDERS = ['__PROFILE_UUID__', '__APPLOCK_UUID__', '__ORGANIZATION__'];
const UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;

const xmlText = (value) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/** Fills the template; throws on any input that would make an invalid or misleading profile. */
export function renderKioskProfile(template, { organization, uuid = randomUUID } = {}) {
  const name = typeof organization === 'string' ? organization.trim() : '';
  if (
    !name ||
    name.length > 120 ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(name) ||
    /^<.*>$/.test(name) ||
    /__[A-Z_]+__/.test(name)
  )
    throw new Error('An organization name is required: 1-120 printable characters');
  for (const placeholder of PLACEHOLDERS)
    if (template.split(placeholder).length !== 2)
      throw new Error(`The template must contain ${placeholder} exactly once`);
  const ids = [uuid(), uuid()].map((value) => String(value).toUpperCase());
  if (!ids.every((id) => UUID.test(id)) || ids[0] === ids[1])
    throw new Error('Invalid payload UUID');
  // Function replacements: a name such as "$&" is inserted literally.
  const text = template
    .replace('__PROFILE_UUID__', () => ids[0])
    .replace('__APPLOCK_UUID__', () => ids[1])
    .replace('__ORGANIZATION__', () => xmlText(name));
  if (/__[A-Z_]+__/.test(text)) throw new Error('The template has an unknown placeholder');
  if (!text.includes(`<key>Identifier</key><string>${KIOSK_BUNDLE_ID}</string>`))
    throw new Error(`The AppLock payload must name the kiosk bundle id ${KIOSK_BUNDLE_ID}`);
  return text;
}

function parseArgs(argv) {
  const options = { out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if ((flag === '--organization' || flag === '--out') && i + 1 < argv.length)
      options[flag.slice(2)] = argv[++i];
    else throw new Error(`Unknown or incomplete argument: ${flag}`);
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const text = renderKioskProfile(readFileSync(PROFILE_TEMPLATE, 'utf8'), options);
    const out = resolve(ROOT, options.out);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text, { mode: 0o644 });
    process.stdout.write(
      [
        `Profile: ${out}`,
        `App: ${KIOSK_BUNDLE_ID} (com.apple.app.lock, supervised iPad only)`,
        'Check on a Mac: plutil -lint <file>; then follow docs/operations/ipad-kiosk-lockdown.md.',
        '',
      ].join('\n'),
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}
