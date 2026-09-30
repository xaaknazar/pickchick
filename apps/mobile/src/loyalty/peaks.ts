// Design proposal only. This catalog neither activates a program nor grants rewards.
export const peaks = [
  {
    id: 'furmanov',
    name: 'Фурманова',
    points: 300,
    reward: 'Любимый соус',
    detail: 'Один соус на выбор к следующему заказу.',
    mood: 'Первая высота. Первый подарок.',
  },
  {
    id: 'kumbel',
    name: 'Кумбель',
    points: 1000,
    reward: 'Комбо в подарок',
    detail: 'Одно базовое комбо из списка программы. Чики с баланса не списываются.',
    mood: 'Поднялся выше - собрал любимое.',
  },
  {
    id: 'panorama',
    name: 'Панорама',
    points: 2000,
    reward: 'Фирменное комбо',
    detail: 'Одно фирменное комбо из списка программы, больше базового.',
    mood: 'Больше вкуса. Шире горизонт.',
  },
  {
    id: 'big-almaty',
    name: 'Большой Алматинский',
    points: 3500,
    reward: 'Комбо на двоих',
    detail: 'Один набор на двоих из списка программы.',
    mood: 'Твой вкус уже на новой высоте.',
  },
  {
    id: 'molodezhny',
    name: 'Молодёжный',
    points: 5500,
    reward: 'На двоих + два соуса',
    detail: 'Комбо на двоих и два любимых соуса из списка программы.',
    mood: 'До облаков - рукой подать.',
  },
  {
    id: 'talgar',
    name: 'Талгар',
    points: 8000,
    reward: 'Сет на компанию',
    detail: 'Один сет на компанию из списка программы и особый значок в профиле.',
    mood: 'Вершина вкуса. Раздели её.',
  },
] as const;

export type Peak = (typeof peaks)[number];
export const proposedProgram = {
  earnPercent: 5,
  chikiValueTenge: 1,
  maxSpendPercent: 30,
  giftDays: 30,
} as const;

// Earned progress is independent of the spendable balance. No wallet mutation here.
export function ascentProgress(earned: number) {
  if (!Number.isSafeInteger(earned) || earned < 0) throw new Error('Invalid ascent progress');
  const reached = peaks.filter((peak) => earned >= peak.points);
  const current = reached.at(-1) ?? null;
  const next = peaks[reached.length] ?? null;
  const base = current?.points ?? 0;
  return {
    reached: reached.length,
    current,
    next,
    remaining: next ? next.points - earned : 0,
    fraction: next ? (earned - base) / (next.points - base) : 1,
  };
}
