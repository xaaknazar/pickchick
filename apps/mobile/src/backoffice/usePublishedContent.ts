import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { API_URL } from '../api';
import { parseContent, type PublishedContent } from './content-model';
const cache = new Map<string, PublishedContent>();
/** Public, validated configuration only. Existing training remains available when unconfigured. */
export function usePublishedContent(branch: string | null | undefined) {
  const [value, setValue] = useState<PublishedContent | null>(
    branch ? (cache.get(branch) ?? null) : null,
  );
  useEffect(() => {
    setValue(branch ? (cache.get(branch) ?? null) : null);
    if (!branch) return;
    let alive = true;
    let running = false;
    const abort = new AbortController();
    const load = async () => {
      if (running || AppState.currentState === 'background') return;
      running = true;
      const request = new AbortController();
      const stop = () => request.abort();
      abort.signal.addEventListener('abort', stop);
      const timeout = setTimeout(stop, 8000);
      try {
        const response = await fetch(`${API_URL}/v1/content/branches/${branch}?channel=mobile`, {
          credentials: 'omit',
          redirect: 'error',
          signal: request.signal,
        });
        if (!response.ok) return;
        const raw = await response.text();
        if (raw.length > 100000) return;
        const parsed = parseContent(JSON.parse(raw), branch);
        if (alive) {
          cache.set(branch, parsed);
          setValue(parsed);
        }
      } catch {
        /* Keep only the last validated public content for this branch. */
      } finally {
        clearTimeout(timeout);
        abort.signal.removeEventListener('abort', stop);
        running = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 60000);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void load();
    });
    return () => {
      alive = false;
      abort.abort();
      clearInterval(timer);
      sub.remove();
    };
  }, [branch]);
  const current = value?.branch_id === branch ? value : null;
  return {
    content: current,
    gameEnabled: (template: PublishedContent['games'][number]['template']) =>
      current?.games.find((g) => g.template === template)?.enabled ?? true,
  };
}
