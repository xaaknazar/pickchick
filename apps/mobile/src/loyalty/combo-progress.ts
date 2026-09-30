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

export function comboNextStep(state?: ComboProgressState, preview = false) {
  const view = comboProgressView(state, preview);
  if (preview)
    return {
      title: 'Ещё 4 комбо до подарка',
      detail: 'Пример: отметка появляется после выдачи комбо.',
      action: 'Выбрать комбо',
    };
  if (view.count === null)
    return {
      title: view.text,
      detail:
        'Отметки не теряются при отсутствии связи. Условия действующей акции уточняйте на кассе.',
      action: 'Открыть меню',
    };
  if (state?.data?.mode === 'practice')
    return {
      title:
        view.count === 7 ? 'Пробный круг собран' : `Ещё ${7 - view.count} комбо до полного круга`,
      detail:
        view.count === 7
          ? '7 из 7. Следующее подходящее комбо начнёт новый пробный круг. Подарок пока оформляется только по правилам акции на кассе.'
          : 'После выдачи Solo, Burger, Pick или Master Combo добавится отметка. Этот счётчик пробный и пока не даёт право на подарок.',
      action: 'Выбрать комбо',
    };
  return {
    title: view.text,
    detail: 'Уточните получение подарка на кассе.',
    action: 'Открыть меню',
  };
}
