import { useEffect } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';
/**
 * Speaks a changed status to VoiceOver. `accessibilityLiveRegion` works on Android and the web
 * only; on iPad a status line, a toast or an error is read only when announced explicitly.
 * Empty text says nothing; the same text is spoken again only when `again` changes.
 */
export function useAnnounce(text: string | null | undefined, again?: unknown) {
  useEffect(() => {
    if (Platform.OS === 'ios' && text) AccessibilityInfo.announceForAccessibility(text);
  }, [text, again]);
}
