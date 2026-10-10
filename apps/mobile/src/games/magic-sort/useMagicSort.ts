import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { useAccount } from '../../useAccount';
import {
  applyRecord,
  createPuzzle,
  isPuzzle,
  isWon,
  moveCount,
  resolveBottleTap,
  undo,
  getHint,
  type GameState,
  type RecordResult,
  type Move,
  type Color,
} from './engine';
import { createGameStorage } from './storage';

const storage = createGameStorage(AsyncStorage);

function demoScope(phone: string) {
  let hash = 2166136261;
  for (const char of phone) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `demo-${(hash >>> 0).toString(16)}`;
}
export type PendingPour = {
  before: GameState;
  accountId: string | null;
  move: Move;
  next: GameState;
  color: Color;
  quantity: number;
};
export function useMagicSort() {
  const { account } = useAccount();
  const scope = account?.customerId ?? (account ? demoScope(account.phone) : null);
  const [game, setGame] = useState<GameState | null>(null);
  const [pending, setPending] = useState<PendingPour | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [paused, setPaused] = useState(false);
  const [notice, setNotice] = useState('Выберите бутылку, затем место для переливания.');
  const [saveError, setSaveError] = useState(false);
  const [record, setRecord] = useState<number | null>(null);
  const [result, setResult] = useState<(RecordResult & { confirmed: boolean }) | null>(null);
  const current = useRef<GameState | null>(null);
  const recordRef = useRef<number | null>(null);
  const moving = useRef<PendingPour | null>(null);
  const owner = useRef(scope);
  owner.current = scope;
  const isPaused = useRef(false);
  // A solved fixed puzzle updates the account record. The storage queue keeps
  // the minimum, so a retry or a reload of the same won board is idempotent.
  const recordWin = useCallback((state: GameState, key: string) => {
    if (!isWon(state) || !isPuzzle(state)) return;
    const moves = moveCount(state);
    setResult(
      (shown) =>
        shown ?? {
          ...applyRecord(recordRef.current, moves),
          confirmed: false,
        },
    );
    void storage
      .saveRecord(key, moves)
      .then((stored) => {
        if (owner.current !== key || current.current !== state) return;
        recordRef.current = stored.best;
        setRecord(stored.best);
        setResult((shown) => (shown?.confirmed ? shown : { ...stored, confirmed: true }));
      })
      .catch(() => {
        if (owner.current === key) setSaveError(true);
      });
  }, []);
  const publish = useCallback(
    (next: GameState) => {
      current.current = next;
      setGame(next);
      if (!isWon(next)) setResult(null);
      const key = owner.current;
      if (key) {
        void storage
          .save(key, next)
          .then(() => {
            if (owner.current === key) setSaveError(false);
          })
          .catch(() => {
            if (owner.current === key) setSaveError(true);
          });
        recordWin(next, key);
      }
    },
    [recordWin],
  );
  useEffect(() => {
    let live = true;
    current.current = null;
    moving.current = null;
    recordRef.current = null;
    setGame(null);
    setPending(null);
    setSelected(null);
    setRecord(null);
    setResult(null);
    if (!scope) return;
    void Promise.all([storage.load(scope), storage.loadRecord(scope).catch(() => null)])
      .then(([saved, best]) => {
        if (!live) return;
        recordRef.current = best;
        setRecord(best);
        // Earlier builds started a random layout per player. Records only compare
        // on the shared fixed puzzle, so such a save is replaced by a fresh start.
        const migrated = !!saved && !isPuzzle(saved);
        const next = saved && !migrated ? saved : createPuzzle();
        current.current = next;
        setGame(next);
        setSaveError(false);
        if (migrated)
          setNotice('Теперь у всех одна раскладка. Отсортируйте её за меньшее число ходов.');
        if (next !== saved)
          void storage.save(scope, next).catch(() => {
            if (live) setSaveError(true);
          });
        recordWin(next, scope);
      })
      .catch(() => {
        if (live) {
          const next = createPuzzle();
          current.current = next;
          setGame(next);
          setSaveError(true);
        }
      });
    return () => {
      live = false;
    };
  }, [scope, recordWin]);
  const pause = useCallback(() => {
    moving.current = null;
    setPending(null);
    setSelected(null);
    isPaused.current = true;
    setPaused(true);
  }, []);
  useFocusEffect(useCallback(() => () => pause(), [pause]));
  useEffect(() => {
    const app = AppState.addEventListener('change', (state) => {
      if (state !== 'active') pause();
    });
    const visibility = () => {
      if (document.visibilityState === 'hidden') pause();
    };
    if (Platform.OS === 'web') document.addEventListener('visibilitychange', visibility);
    return () => {
      app.remove();
      if (Platform.OS === 'web') document.removeEventListener('visibilitychange', visibility);
    };
  }, [pause]);
  const finishPour = useCallback(
    (expected: PendingPour) => {
      if (
        moving.current !== expected ||
        isPaused.current ||
        current.current !== expected.before ||
        owner.current !== expected.accountId
      )
        return;
      moving.current = null;
      setPending(null);
      setSelected(null);
      publish(expected.next);
      setNotice(
        isWon(expected.next) ? 'Все цвета отсортированы.' : 'Перелито. Выберите следующую бутылку.',
      );
    },
    [publish],
  );
  const select = useCallback(
    (index: number) => {
      const state = current.current;
      if (!state || moving.current || isPaused.current) return;
      const action = resolveBottleTap(state, selected, index);
      if (action.kind === 'select') {
        setSelected(action.index);
        setNotice(
          'Теперь выберите бутылку того же цвета или пустую. Жёлтый можно отправить в центр.',
        );
        return;
      }
      if (action.kind === 'deselect') {
        setSelected(null);
        setNotice('Выбор отменён.');
        return;
      }
      if (action.kind === 'blocked') {
        setNotice(
          selected === null
            ? 'Сначала выберите непустую бутылку.'
            : 'Сюда нельзя перелить: нужен тот же верхний цвет и свободное место.',
        );
        return;
      }
      const { from, to, next } = action;
      const bottle = state.bottles[from]!;
      const operation = {
        before: state,
        accountId: owner.current,
        move: { from, to },
        next,
        color: bottle[bottle.length - 1]!,
        quantity: bottle.length - next.bottles[from]!.length,
      };
      moving.current = operation;
      setPending(operation);
    },
    [selected],
  );
  return {
    game,
    record,
    result,
    pending,
    selected,
    paused,
    notice,
    saveError,
    select,
    finishPour,
    pause,
    resume: () => {
      isPaused.current = false;
      setPaused(false);
    },
    undo: () => {
      if (current.current && !moving.current) {
        publish(undo(current.current));
        setSelected(null);
        setNotice('Последний ход отменён.');
      }
    },
    restart: () => {
      if (current.current && !moving.current) {
        publish(createPuzzle());
        setSelected(null);
        setNotice('Раскладка начата заново. Ходы: 0.');
      }
    },
    hint: () => {
      if (!current.current || moving.current) return;
      const hint = getHint(current.current);
      if (hint) {
        setSelected(hint.move.from);
        setNotice(
          `${hint.source === 'witness' ? 'Подсказка' : 'Возможный ход'}: бутылка ${hint.move.from + 1} - ${hint.move.to === 24 ? 'центр' : hint.move.to + 1}.`,
        );
      } else setNotice('Нет доступного хода. Отмените ход или начните заново.');
    },
    retrySave: () => {
      if (current.current) publish(current.current);
    },
  };
}
