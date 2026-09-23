import { MotionPressable as Pressable } from './Motion';
import { useEffect, useState, type ReactNode, type RefObject } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ScreenProps } from '../model';
import { font } from '../theme';
import { ProfileRestoreNotice } from './ProfileRestoreNotice';

// Brand theme from the supplied mobile-v2 source, scoped to its auth screens.
export const authColors = {
  background: '#04143A',
  surface: '#0A2050',
  text: '#F2F6FF',
  muted: '#93A6C9',
  blue: '#2E6FE8',
  blueInk: '#9DC0FF',
  blueSoft: '#12305F',
  border: '#233962',
  danger: '#FFB0AB',
};

export function useAuthKeyboardVisible() {
  const [visible, setVisible] = useState(() => Keyboard.isVisible());
  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      () => setVisible(true),
    );
    const hide = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setVisible(false),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return visible;
}

export function AuthButton({
  title,
  onPress,
  disabled = false,
  testID,
}: {
  title: string;
  onPress(): void;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [s.button, disabled && s.disabled, pressed && !disabled && s.pressed]}
    >
      <Text style={s.buttonText}>{title}</Text>
    </Pressable>
  );
}

export function AuthLayout({
  props,
  topAction,
  title,
  subtitle,
  children,
  footer,
  bottomContent,
  scrollRef,
}: {
  props: ScreenProps;
  topAction?: { label: string; onPress(): void };
  title: string;
  subtitle?: ReactNode;
  children?: ReactNode;
  footer: ReactNode;
  bottomContent?: ReactNode;
  scrollRef?: RefObject<ScrollView | null>;
}) {
  const insets = useSafeAreaInsets();
  const keyboardVisible = useAuthKeyboardVisible();
  return (
    <KeyboardAvoidingView
      testID={`screen-${props.screenId}`}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[s.page, { paddingTop: Math.max(insets.top, 44) }]}
    >
      <ScrollView
        ref={scrollRef}
        testID={`scroll-${props.screenId}`}
        style={s.scroll}
        contentContainerStyle={s.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        showsVerticalScrollIndicator={false}
      >
        {topAction ? (
          <Pressable
            accessibilityRole="button"
            onPress={topAction.onPress}
            style={({ pressed }) => [s.topAction, pressed && s.pressed]}
          >
            <Text style={s.topActionText}>{topAction.label}</Text>
          </Pressable>
        ) : null}
        <Text
          accessibilityRole="header"
          style={[
            s.title,
            !topAction && s.titleWithoutAction,
            props.screenId === 'M04' && s.registrationTitle,
          ]}
        >
          {title}
        </Text>
        {subtitle ? (
          <View style={s.subtitleContainer}>
            {typeof subtitle === 'string' || typeof subtitle === 'number' ? (
              <Text style={s.subtitle}>{subtitle}</Text>
            ) : (
              subtitle
            )}
          </View>
        ) : null}
        <ProfileRestoreNotice restorationOnly />
        {children}
        {bottomContent ? <View style={s.bottomContent}>{bottomContent}</View> : null}
      </ScrollView>
      <View
        testID="bottom-actions"
        style={[
          s.footer,
          props.screenId === 'M04' && s.registrationFooter,
          { paddingBottom: keyboardVisible ? 16 : Math.max(insets.bottom, 16) },
        ]}
      >
        {footer}
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, minHeight: 0, backgroundColor: authColors.background },
  scroll: { flex: 1, minHeight: 0 },
  content: { flexGrow: 1, paddingHorizontal: 22, paddingBottom: 2 },
  topAction: { minHeight: 48, alignSelf: 'flex-start', justifyContent: 'center' },
  topActionText: {
    fontFamily: font.medium,
    fontSize: 15,
    lineHeight: 22,
    color: authColors.blueInk,
  },
  title: {
    fontFamily: font.display,
    fontSize: 34,
    lineHeight: 38,
    letterSpacing: -0.68,
    color: authColors.text,
    marginTop: 14,
  },
  titleWithoutAction: { marginTop: 18 },
  registrationTitle: { fontSize: 32, lineHeight: 35 },
  subtitleContainer: { marginTop: 10 },
  subtitle: { fontFamily: font.body, fontSize: 15, lineHeight: 23, color: authColors.muted },
  bottomContent: { flexGrow: 1, justifyContent: 'flex-end', paddingTop: 22 },
  footer: { paddingHorizontal: 22, paddingTop: 14, flexShrink: 0, gap: 12 },
  registrationFooter: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.08)',
    marginTop: 12,
  },
  button: {
    minHeight: 54,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 16,
    backgroundColor: authColors.blue,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: {
    fontFamily: font.heading,
    fontSize: 18,
    lineHeight: 26,
    color: '#FFFFFF',
    textAlign: 'center',
  },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.75 },
});
