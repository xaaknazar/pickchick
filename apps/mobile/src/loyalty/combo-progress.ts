import type { TestComboProgress } from '@pickchick/test-order-flow/contracts';

export type ComboProgressState = {
  status: 'signed_out' | 'unavailable' | 'loading' | 'ready' | 'error';
  data: TestComboProgress | null;
};

export function comboProgressView(state?: ComboProgressState, preview = false) {
  if (preview) return { count: 3, text: 'Пример: 3 из 7 комбо' };
  if (!state || state.status === 'signed_out')
    return { count: null, text: 'Войдите, чтобы видеть отметки' };
  if (state.status === 'unavailable') return { count: null, text: 'Отметки пока у кассира' };
  if (state.status === 'loading') return { count: null, text: 'Загружаем отметки…' };
  if (state.status === 'error' || !state.data)
    return { count: null, text: 'Не удалось обновить отметки' };
  const { current_stamps: current, completed_cycles: cycles } = state.data;
  const count = current === 0 && cycles > 0 ? 7 : current;
  return { count, text: `Пробные отметки: ${count} из 7` };
}
