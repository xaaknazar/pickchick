import {
  FARM_PROTOCOL,
  FarmCommandSchema,
  FarmStateSchema,
  type FarmCommand,
  type FarmState,
} from '@pickchick/farm-game';

/**
 * `protocol` is the rules version the server accepted. 3 enables land, animals, the order
 * board and daily rewards; 2 means an API that is not updated yet (legacy mode, those
 * features stay hidden and are never sent).
 */
export type FarmSnapshot = { state: FarmState; serverNow: number; protocol: number };
export type FarmIntent = { commandId: string; expectedRevision: number; command: FarmCommand };
export class FarmClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly minimumProtocol: number | null;
  constructor(code: string, status = 0, minimumProtocol: number | null = null) {
    super(code);
    this.code = code;
    this.status = status;
    this.minimumProtocol = minimumProtocol;
  }
}
export const FARM_ENABLED = process.env.EXPO_PUBLIC_PICK_FARM === '1';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function parseSnapshot(value: unknown, protocol: number): FarmSnapshot {
  if (
    !value ||
    typeof value !== 'object' ||
    !('state' in value) ||
    !('serverNow' in value) ||
    typeof value.serverNow !== 'number' ||
    !Number.isSafeInteger(value.serverNow) ||
    value.serverNow < 0
  )
    throw new FarmClientError('INVALID_RESPONSE');
  const state = FarmStateSchema.safeParse(value.state);
  if (!state.success) throw new FarmClientError('INVALID_RESPONSE');
  return { state: state.data, serverNow: value.serverNow, protocol };
}

/** Bounded HTTPS-only transport; the existing account provider owns token rotation. */
export function farmRequest(baseUrl: string, fetcher: typeof fetch = fetch) {
  const base = new URL(baseUrl);
  if (
    base.protocol !== 'https:' ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== '/'
  )
    throw new FarmClientError('INVALID_API_URL');
  // The newest protocol first. An API that still runs protocol 2 rejects it before reading or
  // mutating the save (503 + minimumProtocol 2); the client then stays on 2 for this session.
  let protocol: number = FARM_PROTOCOL;
  const send = async (token: string, intent?: FarmIntent): Promise<FarmSnapshot> => {
    try {
      return await once(token, intent, protocol);
    } catch (error) {
      if (
        protocol > 2 &&
        error instanceof FarmClientError &&
        error.status === 503 &&
        error.minimumProtocol === 2
      ) {
        protocol = 2;
        return once(token, intent, protocol);
      }
      throw error;
    }
  };
  const once = async (
    token: string,
    intent: FarmIntent | undefined,
    version: number,
  ): Promise<FarmSnapshot> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetcher(
        `${base.origin}/v1/customer-farm${intent ? '/commands' : ''}?protocol=${version}`,
        {
          method: intent ? 'POST' : 'GET',
          credentials: 'omit',
          redirect: 'error',
          cache: 'no-store',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            ...(intent ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(intent ? { body: JSON.stringify(intent) } : {}),
        },
      );
      if (
        !response.headers.get('content-type')?.includes('application/json') ||
        Number(response.headers.get('content-length') ?? 0) > 1048576 ||
        !response.body?.getReader
      )
        throw new FarmClientError('INVALID_RESPONSE');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          total += next.value.byteLength;
          if (total > 1048576) {
            controller.abort();
            void reader.cancel().catch(() => {});
            throw new FarmClientError('INVALID_RESPONSE');
          }
          chunks.push(next.value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!response.ok) {
        const code =
          value && typeof value === 'object' && 'code' in value && typeof value.code === 'string'
            ? value.code
            : 'INVALID_RESPONSE';
        const minimum =
          value &&
          typeof value === 'object' &&
          'minimumProtocol' in value &&
          typeof value.minimumProtocol === 'number'
            ? value.minimumProtocol
            : null;
        throw new FarmClientError(
          value && typeof value === 'object' && 'minimumProtocol' in value
            ? 'FARM_CLIENT_UPGRADE_REQUIRED'
            : code,
          response.status,
          minimum,
        );
      }
      return parseSnapshot(value, version);
    } catch (error) {
      if (error instanceof FarmClientError) throw error;
      throw new FarmClientError('NETWORK_UNAVAILABLE');
    } finally {
      clearTimeout(timeout);
    }
  };
  return send;
}

type FarmClientIO = {
  read(): Promise<string | null>;
  write(raw: string | null): Promise<void>;
  request(intent?: FarmIntent): Promise<FarmSnapshot>;
  randomId(): string;
};

/** One durable intent per account. Unknown results are retried with the same command ID. */
export class FarmClient {
  snapshot: FarmSnapshot | null = null;
  private pending: FarmIntent | null = null;
  private working = false;
  private readonly io: FarmClientIO;
  constructor(io: FarmClientIO) {
    this.io = io;
  }
  private async serial<T>(work: () => Promise<T>): Promise<T> {
    if (this.working) throw new FarmClientError('BUSY');
    this.working = true;
    try {
      return await work();
    } finally {
      this.working = false;
    }
  }
  private async restore() {
    const raw = await this.io.read();
    if (raw === null) {
      this.pending = null;
      return;
    }
    try {
      const value = JSON.parse(raw) as FarmIntent;
      if (
        !uuid.test(value.commandId) ||
        !Number.isSafeInteger(value.expectedRevision) ||
        value.expectedRevision < 0
      )
        throw new Error('Invalid intent');
      this.pending = {
        commandId: value.commandId,
        expectedRevision: value.expectedRevision,
        command: FarmCommandSchema.parse(value.command),
      };
    } catch {
      throw new FarmClientError('RECOVERY_REQUIRED');
    }
  }
  private async submit(): Promise<FarmSnapshot> {
    if (!this.pending) throw new FarmClientError('NO_PENDING');
    try {
      const result = await this.io.request(this.pending);
      await this.io.write(null);
      this.pending = null;
      this.snapshot = result;
      return result;
    } catch (error) {
      // Only a definite business rejection permits discarding a command.
      if (error instanceof FarmClientError && [400, 409, 422].includes(error.status)) {
        await this.io.write(null);
        this.pending = null;
        this.snapshot = await this.io.request();
      }
      throw error;
    }
  }
  refresh(): Promise<FarmSnapshot> {
    return this.serial(async () => {
      await this.restore();
      if (this.pending) return this.submit();
      this.snapshot = await this.io.request();
      return this.snapshot;
    });
  }
  send(command: FarmCommand): Promise<FarmSnapshot> {
    return this.serial(async () => {
      await this.restore();
      if (this.pending) throw new FarmClientError('PENDING_RECOVERY');
      if (!this.snapshot) throw new FarmClientError('NOT_READY');
      const intent: FarmIntent = {
        commandId: this.io.randomId(),
        expectedRevision: this.snapshot.state.revision,
        command: FarmCommandSchema.parse(command),
      };
      await this.io.write(JSON.stringify(intent));
      this.pending = intent;
      return this.submit();
    });
  }
}
