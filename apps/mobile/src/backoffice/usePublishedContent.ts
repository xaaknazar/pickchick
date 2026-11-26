import { useCallback, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { API_URL } from '../api';
import { createSharedPoller } from '../shared-poller';
import type { ImageSourcePropType } from 'react-native';
import { getLocale } from '../i18n';
import { parseContent, type GameTemplate, type PublishedContent } from './content-model';
// One 60 s reader per branch for every component that shows its content (see shared-poller.ts).
const published = createSharedPoller<PublishedContent>({
  read: async (branch, signal) => {
    if (AppState.currentState === 'background') return null;
    const request = new AbortController();
    const stop = () => request.abort();
    signal.addEventListener('abort', stop);
    const timeout = setTimeout(stop, 8000);
    try {
      const response = await fetch(`${API_URL}/v1/content/branches/${branch}?channel=mobile`, {
        credentials: 'omit',
        redirect: 'error',
        signal: request.signal,
      });
      if (!response.ok) return null;
      const raw = await response.text();
      if (raw.length > 100000) return null;
      return parseContent(JSON.parse(raw), branch);
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', stop);
    }
  },
  watch: (reload) => {
    const timer = setInterval(reload, 60000);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') reload();
    });
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  },
});
const idle = () => () => {};
/** Public, validated configuration only. Existing training remains available when unconfigured. */
export function usePublishedContent(branch: string | null | undefined) {
  const subscribe = useCallback(
    (listener: () => void) => (branch ? published.subscribe(branch, listener) : idle()),
    [branch],
  );
  const snapshot = () => (branch ? published.get(branch) : null);
  const value = useSyncExternalStore(subscribe, snapshot, snapshot);
  const current = value?.branch_id === branch ? value : null;
  const card = (template: GameTemplate) =>
    current?.game_cards?.find((g) => g.template === template);
  return {
    content: current,
    /** A game stays on until the back office hides it (no configuration: every game is on). */
    gameEnabled: (template: GameTemplate) =>
      card(template)?.enabled ??
      current?.games.find((g) => g.template === template)?.enabled ??
      true,
    /** Name and cover set in the back office (owner 15.11.2026); the app keeps its own otherwise. */
    poster: (template: GameTemplate): { name?: string; cover?: ImageSourcePropType } => {
      const c = card(template);
      if (!c) return {};
      return {
        ...(c.title ? { name: getLocale() === 'kk' ? c.title.kk : c.title.ru } : {}),
        ...(c.cover ? { cover: { uri: `${API_URL}${c.cover.hero}` } } : {}),
      };
    },
  };
}
