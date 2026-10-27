import { t } from '../i18n/core.ts';
import type { CustomerComboRewards } from '@pickchick/contracts';
import type { TestComboProgress } from '@pickchick/test-order-flow/contracts';

export type ComboProgressState = {
  status: 'signed_out' | 'unavailable' | 'loading' | 'ready' | 'error';
  data: TestComboProgress | null;
  commercial?: Extract<CustomerComboRewards, { enabled: true }>;
};

/** Paid combos per gift on the card: «Купи 6 комбо, 7-е в подарок» (owner, 27.10.2026).
 * Equals COMBO_REWARD_THRESHOLD in commerce-core; a unit test keeps them in sync. */
export const COMBO_STAMP_SLOTS = 6;

export function comboProgressView(state?: ComboProgressState, preview = false) {
  if (preview) return { count: 3, text: 'Пример: 3 из 6 комбо' };
  if (!state || state.status === 'signed_out')
    return { count: null, text: 'Войдите, чтобы видеть отметки' };
  if (state.status === 'unavailable') return { count: null, text: 'Отметки пока у кассира' };
  if (state.status === 'loading') return { count: null, text: 'Загружаем отметки…' };
  if (state.status === 'ready' && state.commercial)
    return {
      // An API still on the old 7 + 1 rule may report 7 visible stamps; the card has six.
      count: Math.min(state.commercial.visibleStamps, COMBO_STAMP_SLOTS),
      text: t('Куплено комбо: {p0}', { p0: state.commercial.earnedUnits }),
    };
  if (state.status === 'error' || !state.data)
    return { count: null, text: 'Не удалось обновить отметки' };
  const { count } = practiceRound(state.data.earned_units);
  return { count, text: t('Пробные отметки: {p0} из 6', { p0: count }) };
}

/** The non-redeemable practice counter (test builds only) keeps its server contract with
 * threshold 7 for installed test builds. The card shows the same purchased units on the
 * six-slot scale of the current promotion, so both counters read the same way. */
export function practiceRound(earnedUnits: number) {
  const current = earnedUnits % COMBO_STAMP_SLOTS;
  const rounds = Math.floor(earnedUnits / COMBO_STAMP_SLOTS);
  return { count: current === 0 && rounds > 0 ? COMBO_STAMP_SLOTS : current, rounds };
}

export function comboNextStep(state?: ComboProgressState, preview = false) {
  const view = comboProgressView(state, preview);
  if (preview)
    return {
      title: 'Ещё 3 комбо до подарка',
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
  if (state?.commercial) {
    const reward = state.commercial;
    return {
      title: reward.reconciliationRequired
        ? 'Проверяем отметки после возврата'
        : reward.availableGifts > 0
          ? reward.availableGifts > 1
            ? t('Доступно подарков Pick Combo: {p0}', { p0: reward.availableGifts })
            : t('Pick Combo в подарок доступен')
          : reward.reservedGifts > 0
            ? 'Подарок в оформляемом заказе'
            : t('Ещё {p0} комбо до подарка', { p0: reward.remainingToNextGift }),
      detail:
        'Одна отметка за каждое оплаченное комбо. За шесть отметок - Pick Combo в подарок. Возврат комбо снимает его отметку.',
      action: reward.availableGifts > 0 ? 'Использовать подарок' : 'Выбрать комбо',
    };
  }
  if (state?.data?.mode === 'practice')
    return {
      title:
        view.count === COMBO_STAMP_SLOTS
          ? 'Пробный круг собран'
          : t('Ещё {p0} комбо до полного круга', { p0: COMBO_STAMP_SLOTS - view.count }),
      detail:
        view.count === COMBO_STAMP_SLOTS
          ? '6 из 6. Следующее подходящее комбо начнёт новый пробный круг. Подарок пока оформляется только по правилам акции на кассе.'
          : 'После выдачи Solo, Burger, Pick или Master Combo добавится отметка. Этот счётчик пробный и пока не даёт право на подарок.',
      action: 'Выбрать комбо',
    };
  return {
    title: view.text,
    detail: 'Уточните получение подарка на кассе.',
    action: 'Открыть меню',
  };
}

/** Gift choice is intentionally not persisted as an entitlement. After a restart,
 * a confirmed old gift order may still match the same saved items and comment. */
export function matchesPaidComboCart(pending: string, current: string): boolean {
  if (pending === current) return true;
  try {
    const previous = JSON.parse(pending) as Record<string, unknown>;
    const next = JSON.parse(current) as Record<string, unknown>;
    if (
      !Number.isInteger(previous.giftItemIndex) ||
      typeof previous.giftItemIndex !== 'number' ||
      previous.giftItemIndex < 0 ||
      next.giftItemIndex !== undefined
    )
      return false;
    const { giftItemIndex, ...purchased } = previous;
    void giftItemIndex;
    return JSON.stringify(purchased) === JSON.stringify(next);
  } catch {
    return false;
  }
}
