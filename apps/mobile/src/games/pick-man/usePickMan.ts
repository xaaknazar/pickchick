import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from 'expo-router';
import { advance, createMaze, nextLevel, turn, type Direction, type MazeGame } from './engine';
import { MazeStorage, PICK_MAN_KEY } from './storage';
type Status = 'loading' | 'ready' | 'playing' | 'paused' | 'won' | 'over';
type Session = { game: MazeGame | null; status: Status; best: number };
const storage = new MazeStorage({
  read: () => AsyncStorage.getItem(PICK_MAN_KEY),
  write: (raw) => AsyncStorage.setItem(PICK_MAN_KEY, raw),
});
const visible = () => Platform.OS !== 'web' || document.visibilityState !== 'hidden';
export function usePickMan() {
  const [session, setSession] = useState<Session>({ game: null, status: 'loading', best: 0 });
  const [storageError, setStorageError] = useState(false);
  const current = useRef(session),
    mounted = useRef(false),
    focused = useRef(false),
    active = useRef(AppState.currentState === 'active');
  const frame = useRef<number | null>(null),
    previous = useRef(0),
    lastSave = useRef(0),
    writeVersion = useRef(0);
  const publish = useCallback((next: Session) => {
    current.current = next;
    if (mounted.current) setSession(next);
  }, []);
  const stop = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    previous.current = 0;
  }, []);
  const persist = useCallback(() => {
    const { game, best } = current.current;
    if (!game) return;
    const version = ++writeVersion.current;
    void storage.save(game, best).then((ok) => {
      if (mounted.current && version === writeVersion.current) setStorageError(!ok);
    });
  }, []);
  const pause = useCallback(() => {
    stop();
    if (current.current.status === 'playing') publish({ ...current.current, status: 'paused' });
    persist();
  }, [persist, publish, stop]);
  const canPlay = useCallback(
    () => mounted.current && focused.current && active.current && visible(),
    [],
  );
  const clock = useCallback(() => {
    stop();
    previous.current = performance.now();
    lastSave.current = previous.current;
    const update = (now: number) => {
      if (!canPlay()) {
        pause();
        return;
      }
      const before = current.current;
      if (before.status !== 'playing' || !before.game) return;
      const game = advance(before.game, Math.max(0, Math.min(80, now - previous.current)));
      previous.current = now;
      const next: Session = {
        game,
        best: Math.max(before.best, game.score),
        status: game.status === 'playing' ? 'playing' : game.status,
      };
      current.current = next;
      if (game.ticks !== before.game.ticks) publish(next);
      if (
        now - lastSave.current > 1200 ||
        game.status !== 'playing' ||
        game.lives !== before.game.lives
      ) {
        persist();
        lastSave.current = now;
      }
      if (next.status === 'playing') frame.current = requestAnimationFrame(update);
      else stop();
    };
    frame.current = requestAnimationFrame(update);
  }, [canPlay, pause, persist, publish, stop]);
  const start = useCallback(() => {
    if (!canPlay() || current.current.status === 'loading') return;
    const game = createMaze(Math.floor(Math.random() * 0x100000000));
    publish({ game, status: 'playing', best: current.current.best });
    persist();
    clock();
  }, [canPlay, clock, persist, publish]);
  const resume = useCallback(() => {
    if (current.current.status !== 'paused' || !canPlay()) return;
    publish({ ...current.current, status: 'playing' });
    clock();
  }, [canPlay, clock, publish]);
  const levelUp = useCallback(() => {
    const before = current.current;
    if (before.status !== 'won' || !before.game || !canPlay()) return;
    const game = nextLevel(before.game);
    publish({ game, status: 'playing', best: Math.max(before.best, game.score) });
    persist();
    clock();
  }, [canPlay, clock, persist, publish]);
  const steer = useCallback(
    (direction: Direction) => {
      if (current.current.status !== 'playing' || !current.current.game || !canPlay()) return;
      current.current = { ...current.current, game: turn(current.current.game, direction) };
    },
    [canPlay],
  );
  const restore = useCallback(async () => {
    const { snapshot, error } = await storage.load();
    if (!mounted.current) return;
    const game = snapshot?.game ?? null;
    publish({
      game,
      best: snapshot?.best ?? 0,
      status: game ? (game.status === 'playing' ? 'paused' : game.status) : 'ready',
    });
    setStorageError(error);
  }, [publish]);
  useEffect(() => {
    mounted.current = true;
    void restore();
    return () => {
      mounted.current = false;
      stop();
      persist();
    };
  }, [persist, restore, stop]);
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
    const change = AppState.addEventListener('change', (value) => {
      active.current = value === 'active';
      if (!active.current) pause();
    });
    const hide = () => {
      if (!visible()) pause();
    };
    if (Platform.OS === 'web') {
      document.addEventListener('visibilitychange', hide);
      window.addEventListener('blur', pause);
      window.addEventListener('pagehide', pause);
    }
    return () => {
      change.remove();
      if (Platform.OS === 'web') {
        document.removeEventListener('visibilitychange', hide);
        window.removeEventListener('blur', pause);
        window.removeEventListener('pagehide', pause);
      }
    };
  }, [pause]);
  return {
    ...session,
    storageError,
    start,
    resume,
    pause,
    steer,
    levelUp,
    retrySave: persist,
    retryRestore: restore,
  };
}
