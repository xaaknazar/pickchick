import { MotionPressable as Pressable } from './Motion';
import { useEffect, useRef, type ReactNode } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { font } from '../theme';
import { AuthButton, authColors } from './AuthLayout';

export function BirthDatePickerSheet({
  children,
  onCancel,
  onConfirm,
  confirmDisabled = false,
}: {
  children: ReactNode;
  onCancel(): void;
  onConfirm(): void;
  confirmDisabled?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const sheet = useRef<View>(null);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const node = sheet.current as unknown as HTMLElement;
    const previous = document.activeElement as HTMLElement | null;
    const controls = () =>
      Array.from(node.querySelectorAll<HTMLElement>('input, [role="button"]')).filter(
        (el) => el.getAttribute('aria-disabled') !== 'true',
      );
    controls()[0]?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cancel.current();
      } else if (event.key === 'Tab') {
        event.stopPropagation();
        const items = controls();
        const target = event.shiftKey ? items.at(-1) : items[0];
        if (document.activeElement === (event.shiftKey ? items[0] : items.at(-1))) {
          event.preventDefault();
          target?.focus();
        }
      }
    };
    node.addEventListener('keydown', key);
    return () => {
      node.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, []);
  return (
    <View style={StyleSheet.absoluteFill} onAccessibilityEscape={onCancel}>
      <View style={[s.overlay, { paddingTop: Math.max(insets.top, 16) }]}>
        <Pressable
          accessible={false}
          importantForAccessibility="no"
          onPress={onCancel}
          style={StyleSheet.absoluteFill}
        />
        <View
          ref={sheet}
          testID="birthday-picker"
          accessibilityViewIsModal
          role="dialog"
          aria-modal
          accessibilityLabel="Дата рождения"
          style={s.sheet}
        >
          <ScrollView
            bounces={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={s.content}
            style={s.scroll}
          >
            <View style={s.header}>
              <Text accessibilityRole="header" style={s.title}>
                Дата рождения
              </Text>
              <Pressable
                testID="birthday-picker-cancel"
                accessibilityRole="button"
                onPress={onCancel}
                style={({ pressed }) => [s.cancel, pressed && s.pressed]}
              >
                <Text style={s.cancelText}>Отмена</Text>
              </Pressable>
            </View>
            {children}
          </ScrollView>
          <View style={[s.footer, { paddingBottom: Math.max(insets.bottom, 16) }]}>
            <AuthButton
              title="Готово"
              testID="birthday-picker-confirm"
              disabled={confirmDisabled}
              onPress={onConfirm}
            />
          </View>
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0, 6, 22, 0.7)' },
  sheet: {
    flexShrink: 1,
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    backgroundColor: authColors.surface,
    overflow: 'hidden',
  },
  scroll: { flexShrink: 1 },
  content: { paddingTop: 10, paddingBottom: 6 },
  header: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: 12,
    paddingHorizontal: 22,
  },
  title: { fontFamily: font.heading, fontSize: 24, lineHeight: 32, color: authColors.text },
  cancel: {
    minHeight: 48,
    minWidth: 48,
    marginLeft: 'auto',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelText: { fontFamily: font.medium, fontSize: 15, lineHeight: 22, color: authColors.blueInk },
  footer: { paddingHorizontal: 22, paddingTop: 10 },
  pressed: { opacity: 0.7 },
});
