import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import {
  createGame,
  hardDrop as dropGame,
  move as moveGame,
  rotate as rotateGame,
  softDrop as lowerGame,
  tick,
  type GameState,
} from './engine';
import { PICK_BLOCKS_STORAGE_KEY, PickBlocksStorage } from './storage';

export type PickBlocksStatus = 'loading' | 'ready' | 'playing' | 'paused' | 'over';
type Session = { game: GameState | null; status: PickBlocksStatus; best: number };

// Sharing the queue prevents an exiting screen's save from overwriting a new visit.
const storage = new PickBlocksStorage({
  read: () => AsyncStorage.getItem(PICK_BLOCKS_STORAGE_KEY),
  write: (raw) => AsyncStorage.setItem(PICK_BLOCKS_STORAGE_KEY, raw),
});

const now = () => globalThis.performance.now();
const visible = () => Platform.OS !== 'web' || globalThis.document?.visibilityState !== 'hidden';

export function usePickBlocks() {
  const [session, setSession] = useState<Session>({ game: null, status: 'loading', best: 0 });
  const [storageError, setStorageError] = useState(false);
  const current = useRef(session);
  const mounted = useRef(false);
  const focused = useRef(false);
  const active = useRef(AppState.currentState === 'active');
  const interval = useRef<ReturnType<typeof globalThis.setInterval> | null>(null);
  const previousTick = useRef(0);
  const writeVersion = useRef(0);

  const stopClock = useCallback(() => {
    if (interval.current !== null) globalThis.clearInterval(interval.current);
    interval.current = null;
    previousTick.current = 0;
  }, []);

  const publish = useCallback((next: Session) => {
    current.current = next;
    if (mounted.current) setSession(next);
  }, []);

  const persist = useCallback(() => {
    const latest = current.current;
    if (latest.status === 'loading' || latest.game === null) return;
    const version = ++writeVersion.current;
    void storage.save(latest.game, latest.best).then((result) => {
      if (!mounted.current || version !== writeVersion.current) return;
      setStorageError(!result.ok);
      if (result.best > current.current.best) {
        const next = { ...current.current, best: result.best };
        current.current = next;
        setSession(next);
      }
    });
  }, []);

  const pause = useCallback(() => {
    stopClock();
    const latest = current.current;
    if (latest.status === 'playing') publish({ ...latest, status: 'paused' });
    persist();
  }, [persist, publish, stopClock]);

  const commitGame = useCallback(
    (next: GameState) => {
      const before = current.current;
      if (before.status !== 'playing' || before.game === null) return;
      const nextSession: Session = {
        game: next,
        status: next.over ? 'over' : 'playing',
        best: Math.max(before.best, next.score),
      };
      // Gravity/lock clocks are kept in the ref; React only needs visible changes.
      current.current = nextSession;
      if (
        next.board !== before.game.board ||
        next.active !== before.game.active ||
        next.score !== before.game.score ||
        next.over !== before.game.over
      ) {
        if (mounted.current) setSession(nextSession);
      }
      if (next.over) stopClock();
      if (next.piecesPlaced !== before.game.piecesPlaced || next.over) persist();
    },
    [persist, stopClock],
  );

  const runClock = useCallback(() => {
    stopClock();
    previousTick.current = now();
    interval.current = globalThis.setInterval(() => {
      if (!focused.current || !active.current || !visible()) {
        pause();
        return;
      }
      const latest = current.current;
      if (latest.status !== 'playing' || latest.game === null) return;
      const timestamp = now();
      const delta = Math.max(0, Math.min(100, timestamp - previousTick.current));
      previousTick.current = timestamp;
      commitGame(tick(latest.game, delta));
    }, 50);
  }, [commitGame, pause, stopClock]);

  const canPlay = useCallback(
    () => mounted.current && focused.current && active.current && visible(),
    [],
  );

  const start = useCallback(() => {
    if (current.current.status === 'loading' || !canPlay()) return;
    const seed = Math.floor(Math.random() * 0x1_0000_0000) >>> 0;
    publish({ game: createGame(seed), status: 'playing', best: current.current.best });
    persist();
    runClock();
  }, [canPlay, persist, publish, runClock]);

  const resume = useCallback(() => {
    const latest = current.current;
    if (latest.status !== 'paused' || !latest.game || latest.game.over || !canPlay()) return;
    publish({ ...latest, status: 'playing' });
    runClock();
  }, [canPlay, publish, runClock]);

  const input = useCallback(
    (action: (game: GameState) => GameState, expectedPiece?: number) => {
      const latest = current.current;
      if (latest.status !== 'playing' || latest.game === null || !canPlay()) return;
      // React can still show the old piece for a frame after the clock locks it.
      if (expectedPiece !== undefined && latest.game.piecesPlaced !== expectedPiece) return;
      commitGame(action(latest.game));
    },
    [canPlay, commitGame],
  );
  const move = useCallback(
    (dx: -1 | 1, piece?: number) => input((game) => moveGame(game, dx), piece),
    [input],
  );
  const rotate = useCallback((piece?: number) => input(rotateGame, piece), [input]);
  const softDrop = useCallback((piece?: number) => input(lowerGame, piece), [input]);
  const hardDrop = useCallback((piece?: number) => input(dropGame, piece), [input]);

  const retryStorage = useCallback(() => {
    if (current.current.status === 'loading') return;
    if (current.current.game !== null) {
      persist();
      return;
    }
    publish({ ...current.current, status: 'loading' });
    void storage.load().then(({ snapshot, error }) => {
      if (!mounted.current) return;
      const game = snapshot?.game ?? null;
      publish({
        game,
        best: snapshot?.best ?? 0,
        status: game ? (game.over ? 'over' : 'paused') : 'ready',
      });
      setStorageError(error);
    });
  }, [persist, publish]);

  useEffect(() => {
    let restoring = true;
    mounted.current = true;
    void storage.load().then(({ snapshot, error }) => {
      if (!restoring) return;
      const game = snapshot?.game ?? null;
      publish({
        game,
        best: snapshot?.best ?? 0,
        status: game ? (game.over ? 'over' : 'paused') : 'ready',
      });
      setStorageError(error);
    });
    return () => {
      restoring = false;
      mounted.current = false;
      stopClock();
      const latest = current.current;
      if (latest.status === 'playing') current.current = { ...latest, status: 'paused' };
      persist();
    };
  }, [persist, publish, stopClock]);

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      return () => {
        focused.current = false;
        pause();
      };
    }, [pause]),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      active.current = state === 'active';
      if (!active.current) pause();
    });
    return () => subscription.remove();
  }, [pause]);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const document = globalThis.document;
    const window = globalThis.window;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') pause();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', pause);
    window.addEventListener('pagehide', pause);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', pause);
      window.removeEventListener('pagehide', pause);
    };
  }, [pause]);

  return {
    ...session,
    storageError,
    start,
    pause,
    resume,
    move,
    rotate,
    softDrop,
    hardDrop,
    retryStorage,
  };
}
