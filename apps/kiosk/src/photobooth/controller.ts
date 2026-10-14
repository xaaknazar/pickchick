export type PhotoConfig = { url: string; token: string };
export type PhotoPreview = {
  id: string;
  png: string;
  expiresAt: number;
  width: number;
  height: number;
};
export type PrintJob = {
  id: string;
  previewId: string;
  state: 'sending' | 'sent' | 'failed' | 'unknown';
};
export interface PhotoIO {
  readConfig(): Promise<PhotoConfig | null>;
  writeConfig(config: PhotoConfig): Promise<void>;
  readPending(): Promise<string | null>;
  writePending(id: string | null): Promise<void>;
  request<T>(config: PhotoConfig, path: string, body?: unknown, method?: string): Promise<T>;
  uuid(): string;
  now(): number;
}
export type PhotoState = {
  phase: 'intro' | 'camera' | 'preparing' | 'preview' | 'submitting' | 'result';
  ready: boolean;
  connected: boolean;
  printingEnabled: boolean;
  busy: boolean;
  preview: PhotoPreview | null;
  localUri: string | null;
  job: PrintJob | null;
  error: string | null;
};
export class PhotoController {
  state: PhotoState = {
    phase: 'intro',
    ready: false,
    connected: false,
    printingEnabled: false,
    busy: false,
    preview: null,
    localUri: null,
    job: null,
    error: null,
  };
  config: PhotoConfig | null = null;
  private pending: string | null = null;
  private generation = 0;
  private disposeImage: (() => void) | null = null;
  private listeners = new Set<() => void>();
  private io: PhotoIO;
  constructor(io: PhotoIO) {
    this.io = io;
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.state;
  private set(value: Partial<PhotoState>) {
    this.state = { ...this.state, ...value };
    this.listeners.forEach((fn) => fn());
  }
  async init() {
    try {
      this.config = await this.io.readConfig();
      this.pending = await this.io.readPending();
      this.set({ connected: !!this.config });
      if (this.config) {
        const status = await this.io.request<{ printingEnabled: boolean }>(
          this.config,
          '/v1/status',
        );
        this.set({ printingEnabled: status.printingEnabled === true });
      }
      if (this.pending) await this.check();
    } catch {
      this.set({
        error: this.pending ? 'UNKNOWN' : 'CONNECTION',
        phase: this.pending ? 'result' : 'intro',
      });
    } finally {
      this.set({ ready: true });
    }
  }
  async connect(url: string, code: string) {
    if (this.state.busy || this.pending) return;
    this.set({ busy: true, error: null });
    try {
      const endpoint = new URL(url.trim());
      if (
        endpoint.protocol !== 'https:' ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash ||
        !['', '/'].includes(endpoint.pathname)
      )
        throw Error('ADDRESS');
      const config = { url: endpoint.origin, token: '' };
      const result = await this.io.request<{ token: string }>(config, '/v1/pair', {
        code: code.trim(),
      });
      if (!/^[a-f0-9]{64}$/.test(result.token)) throw Error('PAIRING');
      config.token = result.token;
      await this.io.writeConfig(config);
      this.config = config;
      const status = await this.io.request<{ printingEnabled: boolean }>(config, '/v1/status');
      this.set({ connected: true, printingEnabled: status.printingEnabled === true });
    } catch {
      this.set({ error: 'PAIRING' });
    } finally {
      this.set({ busy: false });
    }
  }
  camera() {
    if (this.state.busy || this.pending || !this.state.ready) return;
    this.clearPhoto();
    this.set({ phase: 'camera', error: null, job: null });
  }
  async captured(image: string, uri: string, dispose: () => void) {
    if (this.state.phase !== 'camera' || this.state.busy) {
      dispose();
      return;
    }
    const version = ++this.generation;
    this.disposeImage = dispose;
    if (!this.config) {
      this.set({ phase: 'preview', localUri: uri });
      return;
    }
    this.set({ phase: 'preparing', busy: true, error: null });
    try {
      const p = await this.io.request<PhotoPreview>(this.config, '/v1/previews', { image });
      if (version !== this.generation) {
        void this.io
          .request(this.config, '/v1/previews/' + p.id, undefined, 'DELETE')
          .catch(() => {});
        return;
      }
      if (
        !p.id ||
        !p.png ||
        !Number.isFinite(p.expiresAt) ||
        ![384, 512, 576].includes(p.width) ||
        p.height < 1 ||
        p.height > 1000
      )
        throw Error('INVALID_PREVIEW');
      this.set({ phase: 'preview', preview: p, localUri: null });
    } catch {
      if (version === this.generation) this.set({ phase: 'camera', error: 'CONNECTION' });
    } finally {
      dispose();
      this.disposeImage = null;
      if (version === this.generation) this.set({ busy: false });
    }
  }
  cameraError() {
    this.set({ error: 'CAMERA' });
  }
  async print() {
    const preview = this.state.preview;
    if (this.state.busy || this.pending || !preview || !this.config || !this.state.printingEnabled)
      return;
    if (this.io.now() >= preview.expiresAt) {
      this.set({ error: 'PREVIEW_EXPIRED' });
      return;
    }
    this.set({ busy: true, phase: 'submitting', error: null });
    const id = this.io.uuid();
    try {
      await this.io.writePending(id);
    } catch {
      this.set({ busy: false, phase: 'preview', error: 'STORAGE' });
      return;
    }
    this.pending = id;
    try {
      const job = await this.io.request<PrintJob>(this.config, '/v1/jobs', {
        id,
        previewId: preview.id,
      });
      this.set({ job, phase: 'result' });
    } catch (e) {
      const code = e instanceof Error ? e.message : '';
      // Only explicit pre-dispatch rejections are safe; timeouts and 5xx remain ambiguous.
      if (['PREVIEW_EXPIRED', 'BUSY', 'PRINT_LIMIT', 'NOT_CONFIGURED'].includes(code)) {
        await this.io.writePending(null).catch(() => {});
        this.pending = null;
        this.set({ error: code, phase: 'preview' });
      } else this.set({ error: 'UNKNOWN', phase: 'result' });
    } finally {
      this.set({ busy: false });
    }
  }
  async check() {
    if (!this.pending || !this.config || this.state.busy) return;
    this.set({ busy: true, phase: 'result', error: null });
    try {
      this.set({ job: await this.io.request<PrintJob>(this.config, '/v1/jobs/' + this.pending) });
    } catch {
      this.set({ error: 'UNKNOWN' });
    } finally {
      this.set({ busy: false });
    }
  }
  clearPhoto() {
    ++this.generation;
    this.disposeImage?.();
    this.disposeImage = null;
    if (this.config && this.state.preview)
      void this.io
        .request(this.config, '/v1/previews/' + this.state.preview.id, undefined, 'DELETE')
        .catch(() => {});
    this.set({ preview: null, localUri: null });
  }
  dispose() {
    this.clearPhoto();
    this.listeners.clear();
  }
  async finish() {
    // Explicit exit acknowledges the status; the durable printer job remains deduplicated.
    if (this.pending && !this.state.busy) {
      await this.io.writePending(null);
      this.pending = null;
    }
    this.clearPhoto();
  }
}
