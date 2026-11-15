import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, transaction } from '@pickchick/database';
import { kaspiCertificate, kaspiExpiration, kaspiPort, privateIPv4 } from '@pickchick/local-orders';
import { edgeInstallConfig } from './edge-migrate.mjs';

/**
 * Owner-only link of a cash desk to its Kaspi Smart POS (ADR-0017, edge schema029). Runs on the
 * branch server with the owner environment, like pos-sales-setup.mjs. Tokens are written to the
 * edge database only and never printed.
 *
 *   node scripts/kaspi-terminal-setup.mjs probe --host 192.168.2.50
 *       prints the SHA-256 of the terminal certificate (compare it on site, then register)
 *   node scripts/kaspi-terminal-setup.mjs register --terminal <cash desk uuid> --host <ip>
 *       --certificate-sha256 <hex> [--name PickChick-1]
 *       calls /v2/register: press «Разрешить» on the terminal within a minute
 *   node scripts/kaspi-terminal-setup.mjs status
 *   node scripts/kaspi-terminal-setup.mjs unlink --terminal <cash desk uuid>
 *
 * Before register, on the terminal: «Настройки» → «Панель администратора» → «Защита интеграции» →
 * «Настроить доступ» (docs/integrations/kaspi-smart-pos-api.md).
 */
export const KASPI_POS_MIGRATION = '029_edge_kaspi_pos.sql';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MESSAGES = {
  INVALID_ARGUMENTS: 'Неверные аргументы: см. шапку scripts/kaspi-terminal-setup.mjs',
  NOT_INSTALLED: 'На сервере точки нет миграции 029 (терминал Kaspi)',
  NOT_OWNER: 'Нужен владелец базы edge (owner-подключение)',
  TERMINAL_UNKNOWN: 'Кассы --terminal нет на этой точке: возьмите terminalId из config.json кассы',
  TERMINAL_INACTIVE: 'Касса выключена (active = false)',
  ALREADY_LINKED: 'У этой кассы уже есть терминал: сначала unlink',
  NOT_LINKED: 'У этой кассы нет терминала',
  CERTIFICATE_MISMATCH: 'Сертификат терминала не совпадает с --certificate-sha256: снова probe',
  UNREACHABLE: 'Нет связи с терминалом: проверьте IP, сеть и что терминал включён',
  REGISTER_REFUSED:
    'Терминал отказал в регистрации: включите «Настроить доступ» и нажмите «Разрешить»',
  REGISTER_ANSWER: 'Терминал ответил без токена: регистрация не записана',
  OPEN_ATTEMPTS: 'У кассы есть незавершённая оплата на терминале: завершите её до unlink',
};
export class KaspiTerminalSetupError extends Error {
  constructor(code, details = {}) {
    super(MESSAGES[code]);
    this.code = code;
    this.details = details;
  }
}

export function parseKaspiTerminalSetupArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    const value = rest[index + 1];
    if (!name?.startsWith('--') || value === undefined || value.startsWith('--'))
      throw new KaspiTerminalSetupError('INVALID_ARGUMENTS');
    options[name.slice(2)] = value;
  }
  const allowed = {
    probe: ['host'],
    register: ['terminal', 'host', 'certificate-sha256', 'name'],
    status: [],
    unlink: ['terminal'],
  }[command];
  if (!allowed || Object.keys(options).some((key) => !allowed.includes(key)))
    throw new KaspiTerminalSetupError('INVALID_ARGUMENTS');
  if ((command === 'probe' || command === 'register') && !privateIPv4(options.host))
    throw new KaspiTerminalSetupError('INVALID_ARGUMENTS');
  if ((command === 'register' || command === 'unlink') && !UUID.test(options.terminal ?? ''))
    throw new KaspiTerminalSetupError('INVALID_ARGUMENTS');
  if (command === 'register') {
    options['certificate-sha256'] = (options['certificate-sha256'] ?? '')
      .toLowerCase()
      .replaceAll(':', '');
    if (!/^[a-f0-9]{64}$/.test(options['certificate-sha256']))
      throw new KaspiTerminalSetupError('INVALID_ARGUMENTS');
    options.name ??= 'PickChick-POS';
    if (!/^[A-Za-z0-9_-]{3,40}$/.test(options.name))
      throw new KaspiTerminalSetupError('INVALID_ARGUMENTS');
  }
  return { command, ...options };
}

async function requireInstalled(client) {
  const ready = (
    await client.query(
      `SELECT to_regclass('kaspi_pos_devices') IS NOT NULL
         AND EXISTS(SELECT 1 FROM schema_migrations WHERE scope='edge' AND version=$1) AS installed`,
      [KASPI_POS_MIGRATION],
    )
  ).rows[0].installed;
  if (!ready) throw new KaspiTerminalSetupError('NOT_INSTALLED');
  const owner = (
    await client.query(
      `SELECT pg_get_userbyid(relowner)=current_user AS owner FROM pg_class WHERE oid='kaspi_pos_devices'::regclass`,
    )
  ).rows[0].owner;
  if (owner !== true) throw new KaspiTerminalSetupError('NOT_OWNER');
}

export async function kaspiTerminalStatus(pool, branchId) {
  return transaction(pool, async (client) => {
    await requireInstalled(client);
    const devices = (
      await client.query(
        `SELECT d.terminal_id,host(d.host) AS host,d.integration_name,d.kaspi_terminal_id,d.serial_number,
         d.token_expires_at,d.created_at,
         (SELECT count(*)::int FROM kaspi_pos_attempts a WHERE a.device_id=d.id AND a.state IN ('created','sending','wait','unknown')) AS open_attempts,
         (SELECT count(*)::int FROM kaspi_pos_attempts a WHERE a.device_id=d.id AND (a.state='lost' OR (a.state='success' AND a.order_id IS NULL))) AS attention_attempts
         FROM kaspi_pos_devices d WHERE d.branch_id=$1 AND d.active ORDER BY d.created_at`,
        [branchId],
      )
    ).rows;
    return {
      devices: devices.map((row) => ({
        ...row,
        token_expires_at: row.token_expires_at.toISOString(),
        created_at: row.created_at.toISOString(),
      })),
    };
  });
}

export async function linkKaspiTerminal(pool, branchId, args, port = kaspiPort) {
  // Checks before the terminal is asked: a register leaves a token on the terminal.
  await transaction(pool, async (client) => {
    await requireInstalled(client);
    const desk = (
      await client.query('SELECT active FROM local_terminals WHERE id=$1 AND branch_id=$2', [
        args.terminal,
        branchId,
      ])
    ).rows[0];
    if (!desk) throw new KaspiTerminalSetupError('TERMINAL_UNKNOWN');
    if (!desk.active) throw new KaspiTerminalSetupError('TERMINAL_INACTIVE');
    if (
      (
        await client.query(
          'SELECT 1 FROM kaspi_pos_devices WHERE branch_id=$1 AND terminal_id=$2 AND active',
          [branchId, args.terminal],
        )
      ).rowCount
    )
      throw new KaspiTerminalSetupError('ALREADY_LINKED');
  });
  const link = { host: args.host, port: 8080, certificateSha256: args['certificate-sha256'] };
  const registered = await port.call(link, 'register', { name: args.name }, { timeoutMs: 90000 });
  if (registered.kind === 'unreachable')
    throw new KaspiTerminalSetupError(
      registered.reason === 'CERTIFICATE' ? 'CERTIFICATE_MISMATCH' : 'UNREACHABLE',
    );
  if (registered.kind === 'refused')
    throw new KaspiTerminalSetupError('REGISTER_REFUSED', {
      terminal_code: registered.statusCode,
      terminal_message: registered.message,
    });
  if (registered.kind !== 'ok') throw new KaspiTerminalSetupError('REGISTER_ANSWER');
  const { accessToken, refreshToken, expirationDate } = registered.data;
  if (
    typeof accessToken !== 'string' ||
    typeof refreshToken !== 'string' ||
    !/^[A-Za-z0-9_.:-]{8,512}$/.test(accessToken) ||
    !/^[A-Za-z0-9_.:-]{8,512}$/.test(refreshToken)
  )
    throw new KaspiTerminalSetupError('REGISTER_ANSWER');
  const expires = kaspiExpiration(expirationDate) ?? new Date(Date.now() + 4 * 60 * 60 * 1000);
  const info = await port.call(link, 'deviceinfo', {}, { token: accessToken });
  const field = (name) =>
    info.kind === 'ok' && typeof info.data[name] === 'string' && info.data[name].trim()
      ? info.data[name].trim().slice(0, 64)
      : null;
  const id = randomUUID();
  await transaction(pool, async (client) => {
    await requireInstalled(client);
    await client.query(
      `INSERT INTO kaspi_pos_devices(id,branch_id,terminal_id,host,certificate_sha256,integration_name,
       access_token,refresh_token,token_expires_at,kaspi_terminal_id,serial_number)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id,
        branchId,
        args.terminal,
        args.host,
        args['certificate-sha256'],
        args.name,
        accessToken,
        refreshToken,
        expires,
        field('terminalId'),
        field('serialNum'),
      ],
    );
  });
  return {
    linked: true,
    terminal_id: args.terminal,
    host: args.host,
    kaspi_terminal_id: field('terminalId'),
    serial_number: field('serialNum'),
    token_expires_at: expires.toISOString(),
  };
}

export async function unlinkKaspiTerminal(pool, branchId, args) {
  return transaction(pool, async (client) => {
    await requireInstalled(client);
    const device = (
      await client.query(
        'SELECT id FROM kaspi_pos_devices WHERE branch_id=$1 AND terminal_id=$2 AND active FOR UPDATE',
        [branchId, args.terminal],
      )
    ).rows[0];
    if (!device) throw new KaspiTerminalSetupError('NOT_LINKED');
    if (
      (
        await client.query(
          `SELECT 1 FROM kaspi_pos_attempts WHERE device_id=$1 AND state IN ('created','sending','wait','unknown')`,
          [device.id],
        )
      ).rowCount
    )
      throw new KaspiTerminalSetupError('OPEN_ATTEMPTS');
    await client.query('UPDATE kaspi_pos_devices SET active=false WHERE id=$1', [device.id]);
    return { unlinked: true, terminal_id: args.terminal };
  });
}

export async function runKaspiTerminalSetup(pool, branchId, args, port = kaspiPort) {
  if (args.command === 'status') return kaspiTerminalStatus(pool, branchId);
  if (args.command === 'register') return linkKaspiTerminal(pool, branchId, args, port);
  return unlinkKaspiTerminal(pool, branchId, args);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let pool;
  let command = 'unknown';
  try {
    const args = parseKaspiTerminalSetupArgs(process.argv.slice(2));
    command = args.command;
    let result;
    if (command === 'probe') {
      try {
        result = { host: args.host, certificate_sha256: await kaspiCertificate(args.host) };
      } catch {
        throw new KaspiTerminalSetupError('UNREACHABLE');
      }
    } else {
      const config = edgeInstallConfig(process.env);
      pool = createPool(config.databaseUrl, 1);
      result = await runKaspiTerminalSetup(pool, config.branchId, args);
    }
    console.log(JSON.stringify({ event: `kaspi_terminal_${command}`, ...result }, null, 2));
  } catch (error) {
    if (error instanceof KaspiTerminalSetupError)
      console.error(
        JSON.stringify(
          {
            event: 'kaspi_terminal_setup_refused',
            command,
            code: error.code,
            message: error.message,
            ...error.details,
          },
          null,
          2,
        ),
      );
    // Anything else (connection, configuration) stays opaque: no URL, token or credential is printed.
    else console.error(JSON.stringify({ event: 'kaspi_terminal_setup_failed', command }));
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}
