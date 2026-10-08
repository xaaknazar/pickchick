import { useMemo, useRef, type ReactNode } from 'react';
import { Animated, Modal, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, useMetrics } from '../theme';
import { useEnter } from './motion';
/**
 * v3 dialog. The backdrop fades in over 240 ms; a `bottom` sheet slides up its
 * own height over 440 ms on the v3 ease (prototype `sheetUp`), a `center` card
 * rises 40 pt while fading in. Static under reduced motion; buttons are live
 * from the first frame.
 */
export function Dialog({
  visible,
  children,
  onClose,
  testID,
  footer,
  placement = 'center',
  tone = 'default',
}: {
  visible: boolean;
  children: ReactNode;
  onClose: () => void;
  testID?: string;
  footer?: ReactNode;
  placement?: 'center' | 'bottom';
  /** `brand` is the v3 blue sheet for content built for the blue product screen. */
  tone?: 'default' | 'brand';
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Sheet testID={testID} footer={footer} placement={placement} tone={tone}>
        {children}
      </Sheet>
    </Modal>
  );
}

/** Mounted on every open, so the entrance replays each time the dialog shows. */
function Sheet({
  children,
  testID,
  footer,
  placement,
  tone,
}: {
  children: ReactNode;
  testID?: string;
  footer?: ReactNode;
  placement: 'center' | 'bottom';
  tone: 'default' | 'brand';
}) {
  const { px, v, height } = useMetrics();
  const safe = useSafeAreaInsets();
  const bottom = placement === 'bottom';
  const shade = useEnter(0, 240, 'css');
  const rise = useEnter(0, 440);
  const distance = useRef(new Animated.Value(bottom ? height : v(40))).current;
  const offset = useMemo(
    () => Animated.multiply(Animated.subtract(1, rise), distance),
    [distance, rise],
  );
  const inset = Math.max(safe.bottom, px(28));
  return (
    <View
      style={{
        flex: 1,
        justifyContent: bottom ? 'flex-end' : 'center',
        padding: px(28),
        paddingTop: Math.max(safe.top, px(28)),
        paddingBottom: inset,
      }}
    >
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(4,20,58,.62)', opacity: shade }]}
      />
      <Animated.View
        accessibilityViewIsModal
        testID={testID}
        onLayout={(event) => {
          if (bottom) distance.setValue(event.nativeEvent.layout.height + inset);
        }}
        style={{
          width: '100%',
          maxWidth: 760,
          maxHeight: height - Math.max(56, safe.top + safe.bottom),
          alignSelf: 'center',
          borderRadius: bottom ? 40 : 32,
          backgroundColor: tone === 'brand' ? colors.blue : colors.white,
          overflow: 'hidden',
          opacity: bottom ? 1 : rise,
          transform: [{ translateY: offset }],
        }}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          style={{ flexShrink: 1 }}
          contentContainerStyle={{ padding: px(32), gap: px(24) }}
        >
          {children}
        </ScrollView>
        {footer ? (
          <View
            style={{
              padding: px(24),
              borderTopWidth: 1,
              borderColor: tone === 'brand' ? colors.glassLine : colors.border,
            }}
          >
            {footer}
          </View>
        ) : null}
      </Animated.View>
    </View>
  );
}
