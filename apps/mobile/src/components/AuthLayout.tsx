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
  useWindowDimensions,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ScreenProps } from '../model';
import { CloseButton, Icon } from './UI';
import { colors, font } from '../theme';
import { ProfileRestoreNotice } from './ProfileRestoreNotice';

// Brand theme from the supplied mobile-v2 source, scoped to its auth screens.
export const authColors = {
  background: '#04143A',
  surface: '#0B2255',
  text: '#F2F6FF',
  muted: '#A3B4D6',
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
  icon,
}: {
  title: string;
  onPress(): void;
  disabled?: boolean;
  testID?: string;
  icon?: 'phone-portrait-outline';
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
      {icon ? <Icon name={icon} color="#251609" size={18} /> : null}
      <Text style={[s.buttonText, disabled && { color: authColors.muted }]}>{title}</Text>
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
  overlay,
}: {
  props: ScreenProps;
  topAction?: { label: string; onPress(): void };
  title: string;
  subtitle?: ReactNode;
  children?: ReactNode;
  footer: ReactNode;
  bottomContent?: ReactNode;
  scrollRef?: RefObject<ScrollView | null>;
  overlay?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const keyboardVisible = useAuthKeyboardVisible();
  const { height } = useWindowDimensions();
  const top = props.inSheet ? Math.max(insets.top + 10, Math.min(62, height * 0.08)) : 0;
  const gradient = 'linear-gradient(180deg, #0A2257 0%, #04143A 300px)';
  return (
    <KeyboardAvoidingView
      testID={`screen-${props.screenId}`}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={top}
      style={[
        s.page,
        { paddingTop: props.inSheet ? 16 : Math.max(insets.top, 44) },
        (Platform.OS === 'web'
          ? { backgroundImage: gradient }
          : { experimental_backgroundImage: gradient }) as ViewStyle,
      ]}
    >
      <View
        style={{ flex: 1 }}
        pointerEvents={overlay ? 'none' : 'auto'}
        accessibilityElementsHidden={!!overlay}
        importantForAccessibility={overlay ? 'no-hide-descendants' : 'auto'}
        aria-hidden={!!overlay}
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
          {props.screenId !== 'M04' ? (
            <View style={s.topAction}>
              {props.screenId === 'M03' ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Изменить номер"
                  onPress={topAction?.onPress ?? props.goBack}
                  style={s.back}
                >
                  <Icon name="chevron-back" size={24} color={authColors.text} />
                </Pressable>
              ) : (
                <CloseButton label="Закрыть вход" onPress={props.goBack} />
              )}
            </View>
          ) : null}
          <Text
            accessibilityRole="header"
            style={[
              s.title,
              props.screenId === 'M04' && s.titleWithoutAction,
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
      </View>
      {overlay}
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, minHeight: 0, backgroundColor: authColors.background },
  scroll: { flex: 1, minHeight: 0 },
  content: {
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingBottom: 2,
  },
  topAction: { minHeight: 48, marginLeft: -8, marginBottom: 16 },
  back: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  topActionText: {
    fontFamily: font.medium,
    fontSize: 15,
    lineHeight: 22,
    color: authColors.blueInk,
  },
  title: {
    fontFamily: font.display,
    fontSize: 28,
    lineHeight: 34,
    letterSpacing: -0.68,
    color: authColors.text,
    marginTop: 8,
  },
  titleWithoutAction: { marginTop: 64 },
  registrationTitle: { fontSize: 30, lineHeight: 38 },
  subtitleContainer: { marginTop: 10 },
  subtitle: { fontFamily: font.body, fontSize: 15, lineHeight: 23, color: authColors.muted },
  bottomContent: { flexGrow: 1, justifyContent: 'flex-end', paddingTop: 22 },
  footer: {
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
    paddingHorizontal: 24,
    paddingTop: 14,
    flexShrink: 0,
    gap: 12,
  },
  registrationFooter: { marginTop: 12 },
  button: {
    minHeight: 56,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 28,
    backgroundColor: colors.accent,
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: {
    fontFamily: font.heading,
    fontSize: 18,
    lineHeight: 26,
    color: '#251609',
    textAlign: 'center',
  },
  disabled: { backgroundColor: '#16295A', opacity: 0.5 },
  pressed: { opacity: 0.75 },
});
