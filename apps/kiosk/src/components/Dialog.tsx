import type { ReactNode } from 'react';
import { Modal, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, useMetrics } from '../theme';
import { useMotionPreference } from './useMotionPreference';
export function Dialog({
  visible,
  children,
  onClose,
  testID,
  footer,
  placement = 'center',
}: {
  visible: boolean;
  children: ReactNode;
  onClose: () => void;
  testID?: string;
  footer?: ReactNode;
  placement?: 'center' | 'bottom';
}) {
  const { px, height } = useMetrics();
  const safe = useSafeAreaInsets();
  const reduced = useMotionPreference();
  return (
    <Modal
      visible={visible}
      transparent
      animationType={reduced ? 'none' : 'fade'}
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View
        style={{
          flex: 1,
          backgroundColor: 'rgba(7,27,69,.58)',
          justifyContent: placement === 'bottom' ? 'flex-end' : 'center',
          padding: px(28),
          paddingTop: Math.max(safe.top, px(28)),
          paddingBottom: Math.max(safe.bottom, px(28)),
        }}
      >
        <View
          accessibilityViewIsModal
          testID={testID}
          style={{
            width: '100%',
            maxWidth: 760,
            maxHeight: height - Math.max(56, safe.top + safe.bottom),
            alignSelf: 'center',
            borderRadius: 24,
            backgroundColor: colors.white,
            overflow: 'hidden',
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
            <View style={{ padding: px(24), borderTopWidth: 1, borderColor: colors.border }}>
              {footer}
            </View>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}
