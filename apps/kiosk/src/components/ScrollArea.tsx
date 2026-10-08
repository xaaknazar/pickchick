import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Animated, ScrollView, View } from 'react-native';
import { useMetrics } from '../theme';
import { ScrollOffsetContext, ScrollTargetContext, type ScrollTargets } from './scroll';
import { useMotionPreference } from './useMotionPreference';
/** A request to bring a registered section (useScrollTarget) to the top. */
export interface ScrollFocus {
  /** Id the section registered with. */
  target: string;
  /** Bump to repeat a request for the same section. */
  request: number;
  /** Only move forward, and only when the section is more than 40 pt below. */
  ahead?: boolean;
}
/**
 * Vertical scroller. `parallax` shares its live offset with the content (the
 * product hero drifts and grows as the page scrolls, natively driven). `focus`
 * smooth-scrolls a registered section to 24 pt below the top (instantly under
 * reduced motion).
 */
export function ScrollArea({
  children,
  testID,
  onInteraction,
  fill = false,
  parallax = false,
  focus,
}: {
  children?: ReactNode;
  testID?: string;
  onInteraction?: () => void;
  fill?: boolean;
  parallax?: boolean;
  focus?: ScrollFocus;
}) {
  const { v } = useMetrics();
  const reduced = useMotionPreference();
  const scroller = useRef<ScrollView>(null);
  const content = useRef<View>(null);
  const offsetY = useRef(new Animated.Value(0)).current;
  const offset = useRef(0);
  const size = useRef({ content: 0, view: 0 });
  const sections = useRef(new Map<string, View>()).current;
  const targets = useMemo<ScrollTargets>(
    () => ({
      register: (id, view) => {
        if (view) sections.set(id, view);
        else sections.delete(id);
      },
    }),
    [sections],
  );
  const onScroll = useMemo(
    () =>
      Animated.event([{ nativeEvent: { contentOffset: { y: offsetY } } }], {
        useNativeDriver: true,
        listener: (event: { nativeEvent: { contentOffset: { y: number } } }) => {
          offset.current = event.nativeEvent.contentOffset.y;
        },
      }),
    [offsetY],
  );
  const request = focus ? focus.target + '#' + focus.request : '';
  const ahead = !!focus?.ahead;
  useEffect(() => {
    const id = request.slice(0, request.lastIndexOf('#'));
    const section = id ? sections.get(id) : undefined;
    const host = content.current;
    if (!section || !host) return;
    section.measureLayout(
      host,
      (_x, y) => {
        const end = Math.max(0, size.current.content - size.current.view);
        const top = Math.min(end, Math.max(0, y - v(24)));
        if (ahead && top <= offset.current + v(40)) return;
        scroller.current?.scrollTo({ y: top, animated: !reduced });
      },
      () => {},
    );
    // Only a new request scrolls; motion or size changes never repeat it.
  }, [request]);
  return (
    <ScrollTargetContext.Provider value={targets}>
      <ScrollOffsetContext.Provider value={parallax ? offsetY : null}>
        <Animated.ScrollView
          ref={scroller}
          testID={testID}
          style={{ flex: 1, minHeight: 0 }}
          keyboardShouldPersistTaps="handled"
          onScrollBeginDrag={onInteraction}
          onScroll={onScroll}
          scrollEventThrottle={16}
          onLayout={(event) => {
            size.current.view = event.nativeEvent.layout.height;
          }}
          onContentSizeChange={(_width, height) => {
            size.current.content = height;
          }}
          contentContainerStyle={fill ? { flexGrow: 1 } : undefined}
        >
          <View ref={content} collapsable={false} style={fill ? { flexGrow: 1 } : undefined}>
            {children}
          </View>
        </Animated.ScrollView>
      </ScrollOffsetContext.Provider>
    </ScrollTargetContext.Provider>
  );
}
