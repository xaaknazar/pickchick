#!/usr/bin/env node
/**
 * Owner operator for cloud kitchen screens (cloud 056, ADR-0014 S4), the alternative to the
 * back-office routes. Every write needs --operator and --reason and lands in the screen journal
 * (cloud_kitchen_screen_events) as `owner:<operator>`. The pairing code is printed once to
 * stdout, valid 10 minutes; nothing secret is written to logs or files. Uses CLOUD_DATABASE_URL.
 *
 *   create       --branch <uuid> --role prep|assembly|display [--station <uuid>]... --name <text>
 *   pairing-code --branch <uuid> --screen <uuid>       (new code: first pairing or rotation)
 *   revoke       --branch <uuid> --screen <uuid>
 *   list         --branch <uuid>
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createPool, transaction } from '@pickchick/database';
import {
  createScreenInTransaction,
  issuePairingCodeInTransaction,
  listScreens,
  revokeScreenInTransaction,
} from '@pickchick/cloud-kitchen';

export class ScreenOwnerError extends Error {}
const COMMANDS = ['create', 'pairing-code', 'revoke', 'list'];
const OPTIONS = ['branch', 'role', 'station', 'name', 'screen', 'operator', 'reason'];

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command)) throw new ScreenOwnerError('Unknown command');
  const values = { station: [] };
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i]?.startsWith('--') ? rest[i].slice(2) : null;
    const value = rest[i + 1];
    if (!name || !OPTIONS.includes(name) || value === undefined || value.startsWith('--'))
      throw new ScreenOwnerError('Invalid arguments');
    if (name === 'station') values.station.push(value);
    else if (name in values) throw new ScreenOwnerError('Repeated argument');
    else values[name] = value;
  }
  const need = (...names) => {
    for (const name of names)
      if (typeof values[name] !== 'string') throw new ScreenOwnerError(`--${name} is required`);
  };
  need('branch');
  if (command !== 'list') need('operator', 'reason');
  if (command === 'create') need('role', 'name');
  if (command === 'pairing-code' || command === 'revoke') need('screen');
  return { command, ...values };
}

export async function runScreenOwner(pool, argv) {
  const args = parseArgs(argv);
  const actor = 'owner:' + args.operator;
  if (args.command === 'list') return listScreens(pool, args.branch);
  return transaction(pool, async (db) => {
    if (args.command === 'create') {
      const screen = await createScreenInTransaction(db, {
        branchId: args.branch,
        role: args.role,
        stationIds: args.station,
        name: args.name,
        actor,
        reason: args.reason,
      });
      return issuePairingCodeInTransaction(db, {
        branchId: args.branch,
        screenId: screen.screenId,
        actor,
        reason: args.reason,
      });
    }
    const ref = { branchId: args.branch, screenId: args.screen, actor, reason: args.reason };
    return args.command === 'revoke'
      ? revokeScreenInTransaction(db, ref)
      : issuePairingCodeInTransaction(db, ref);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const url = process.env.CLOUD_DATABASE_URL;
  if (!url) {
    process.stderr.write('CLOUD_DATABASE_URL is required\n');
    process.exitCode = 1;
  } else {
    const pool = createPool(url);
    try {
      process.stdout.write(
        JSON.stringify(await runScreenOwner(pool, process.argv.slice(2))) + '\n',
      );
    } catch (error) {
      process.stderr.write(
        (error instanceof ScreenOwnerError ? error.message : `Failed: ${error?.code ?? 'error'}`) +
          '\n',
      );
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  }
}
