import type { ReactNode } from 'react';
import { Platform, View, type ViewStyle } from 'react-native';
import { redesign, useMetrics } from '../theme';
/**
 * Owner-approved glass (kiosk redesign 2026-10-13): translucent navy fill, 1 px light line,
 * inner top highlight and a soft drop shadow. Used by every header control and the bottom
 * panels. `shape` sets the outline only; size and placement belong to the caller's Wrapper.
 * iOS has no backdrop blur in React Native, so the fill carries the look there; the web
 * build adds `backdrop-filter: blur(18px) saturate(150%)`.
 */
export function GlassPanel({
  children,
  shape = 'pill',
  testID,
}: {
  children?: ReactNode;
  shape?: 'pill' | 'circle' | 'bar';
  testID?: string;
}) {
  const { v } = useMetrics();
  const web: ViewStyle =
    Platform.OS === 'web'
      ? ({
          backdropFilter: 'blur(18px) saturate(150%)',
          WebkitBackdropFilter: 'blur(18px) saturate(150%)',
          boxShadow: `inset 0 1px 0 ${redesign.glassHighlight}, 0 ${v(10)}px ${v(30)}px ${redesign.glassShadow}`,
        } as unknown as ViewStyle)
      : {
          shadowColor: '#020A1F',
          shadowOpacity: 0.18,
          shadowRadius: v(15),
          shadowOffset: { width: 0, height: v(10) },
        };
  return (
    <View
      testID={testID}
      style={[
        {
          backgroundColor: redesign.glass,
          borderWidth: 1,
          borderColor: redesign.glassLine,
          borderTopColor: redesign.glassHighlight,
          borderRadius: shape === 'bar' ? v(56) : 999,
          overflow: Platform.OS === 'web' ? 'hidden' : 'visible',
          flexDirection: 'row',
          alignItems: 'center',
          minWidth: 0,
        },
        web,
      ]}
    >
      {children}
    </View>
  );
}
