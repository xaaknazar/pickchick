import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { useNavigationContainerRef, useRoute } from 'expo-router';
import { heroHostVisible, type HeroNavigationState } from '../hero-playback';

/**
 * Whether the screen hosting the hero video is on display. Unlike focus, a sheet over the
 * menu (cart, checkout, order status, sign-in) keeps it visible; a tab switch or a full screen
 * hides it. Only state changes here: the player itself is owned by its component.
 */
export function useHeroHostVisible(): boolean {
  const container = useNavigationContainerRef();
  const { key } = useRoute();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const update = () => {
      const state = container.isReady()
        ? (container.getRootState() as unknown as HeroNavigationState)
        : undefined;
      setVisible(heroHostVisible(state, key, Platform.OS));
    };
    update();
    return container.addListener('state', update);
  }, [container, key]);
  return visible;
}
