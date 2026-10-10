import { apiPrefix } from './api.js';
import { UUID } from './types.js';
type Identity = {
  terminalId: string;
  mode: 'prep' | 'assembly' | 'display';
  branchId?: string;
  generation?: number;
};
export class TerminalAccess {
  enabled = false;
  paired = false;
  mode: Identity['mode'] = 'prep';
  terminalId: string | undefined;
  busy = false;
  error = '';
  constructor(private readonly changed: () => void) {}
  configure(config: Record<string, unknown>) {
    this.enabled = config['pairingEnabled'] === true;
    if (!this.enabled) return;
    if (!['prep', 'assembly', 'display'].includes(String(config['mode'])))
      throw new Error('INVALID_CONFIG');
    this.mode = config['mode'] as Identity['mode'];
    this.paired = config['paired'] === true;
    if (typeof config['terminalId'] === 'string' && UUID.test(config['terminalId']))
      this.terminalId = config['terminalId'];
  }
  private identity(raw: unknown) {
    if (!raw || typeof raw !== 'object') throw new Error('INVALID_RESPONSE');
    const v = raw as Identity;
    if (typeof v.terminalId !== 'string' || !UUID.test(v.terminalId) || v.mode !== this.mode)
      throw new Error('INVALID_RESPONSE');
    this.terminalId = v.terminalId;
    this.paired = true;
  }
  async check() {
    if (!this.enabled || !this.paired || this.busy) return;
    this.busy = true;
    try {
      const response = await fetch(apiPrefix + '/edge/v1/terminals/session', {
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(12000),
      });
      if (response.status === 401) {
        this.paired = false;
        this.terminalId = undefined;
        this.error = 'Экран отключён. Получите новый код у управляющего.';
        return;
      }
      if (!response.ok) throw new Error();
      this.identity(await response.json());
      this.error = '';
    } catch {
      this.error = 'Нет ответа кассы. Привязка сохранена, повторный код не нужен.';
    } finally {
      this.busy = false;
      this.changed();
    }
  }
  async pair(code: string) {
    if (this.busy) return false;
    if (!/^([a-f0-9]{4}-){7}[a-f0-9]{4}$|^[a-f0-9]{32}$/i.test(code.trim())) {
      this.error = 'Введите полный код из раздела «Устройства».';
      this.changed();
      return false;
    }
    this.busy = true;
    this.error = '';
    try {
      const response = await fetch(apiPrefix + '/edge/v1/terminals/pair', {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(12000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim() }),
      });
      if (!response.ok) {
        this.error =
          response.status === 429
            ? 'Слишком много попыток. Подождите минуту.'
            : 'Код не принят: проверьте назначение экрана и срок действия.';
        return false;
      }
      this.identity(await response.json());
      return true;
    } catch {
      this.error =
        'Ответ не получен. Обновите экран: привязка могла сохраниться. Новый код автоматически не запрашивается.';
      return false;
    } finally {
      this.busy = false;
      this.changed();
    }
  }
}
