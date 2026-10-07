import type { ReactNode } from 'react';
import { View, type ViewStyle } from 'react-native';
import { useMetrics } from '../theme';
/** Layout only. No appearance, style bag, prop spread, or child mutation. */
export interface WrapperProps {
  children?: ReactNode;
  dir?: 'row' | 'column';
  gap?: number;
  padding?: number;
  paddingX?: number;
  paddingY?: number;
  margin?: number;
  flex?: number;
  align?: ViewStyle['alignItems'];
  justify?: ViewStyle['justifyContent'];
  wrap?: boolean;
  width?: ViewStyle['width'];
  maxWidth?: number;
  alignSelf?: ViewStyle['alignSelf'];
  testID?: string;
}
export function Wrapper({
  children,
  dir = 'column',
  gap = 0,
  padding = 0,
  paddingX,
  paddingY,
  margin = 0,
  flex,
  align,
  justify,
  wrap = false,
  width,
  maxWidth,
  alignSelf,
  testID,
}: WrapperProps) {
  const { px } = useMetrics();
  return (
    <View
      testID={testID}
      style={{
        flexDirection: dir,
        gap: px(gap),
        padding: px(padding),
        paddingHorizontal: paddingX === undefined ? undefined : px(paddingX),
        paddingVertical: paddingY === undefined ? undefined : px(paddingY),
        margin: px(margin),
        flex,
        alignItems: align,
        justifyContent: justify,
        flexWrap: wrap ? 'wrap' : 'nowrap',
        width,
        maxWidth,
        alignSelf,
        minWidth: 0,
        minHeight: 0,
      }}
    >
      {children}
    </View>
  );
}
