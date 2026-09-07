import type { ComponentProps, ReactNode } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { assets } from '../assets';
import { BluePattern } from './PatternBackground';
import { colors, fonts, useMetrics } from '../theme';
import { copy, type Locale } from '../i18n';
export type IconName = ComponentProps<typeof Ionicons>['name'];
export function Body({ children, style, testID, ...rest }: ComponentProps<typeof Text>) {
  const { body } = useMetrics();
  return (
    <Text
      {...rest}
      testID={testID}
      style={[
        { fontFamily: fonts.body, fontSize: body, lineHeight: body * 1.38, color: colors.ink },
        style,
      ]}
    >
      {children}
    </Text>
  );
}
export function Heading({
  children,
  size = 42,
  color = colors.ink,
  style,
  ...rest
}: ComponentProps<typeof Text> & { size?: number; color?: string }) {
  const { px } = useMetrics();
  const fontSize = px(size);
  return (
    <Text
      {...rest}
      style={[{ fontFamily: fonts.heavy, fontSize, lineHeight: fontSize * 1.13, color }, style]}
    >
      {children}
    </Text>
  );
}
export function Icon({
  name,
  size = 28,
  color = colors.ink,
}: {
  name: IconName;
  size?: number;
  color?: string;
}) {
  return <Ionicons name={name} size={size} color={color} />;
}
export function Button({
  label,
  onPress,
  testID,
  disabled,
  busy,
  tone = 'orange',
  icon,
  style,
  textStyle,
  compact = false,
}: {
  label: string;
  onPress: () => void;
  testID?: string;
  disabled?: boolean;
  busy?: boolean;
  tone?: 'orange' | 'blue' | 'outline' | 'glass' | 'white';
  icon?: IconName;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  compact?: boolean;
}) {
  const { px } = useMetrics();
  const ink = disabled
    ? colors.muted
    : tone === 'outline' || tone === 'white'
      ? colors.blue
      : colors.white;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || busy, busy }}
      testID={testID}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        {
          minHeight: Math.max(52, px(compact ? 70 : 110)),
          paddingVertical: px(20),
          paddingHorizontal: px(24),
          borderRadius: px(compact ? 20 : 28),
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'row',
          gap: px(16),
          borderWidth: tone === 'outline' ? 2 : 0,
          borderColor: colors.blue,
          backgroundColor: disabled
            ? colors.border
            : tone === 'orange'
              ? colors.orange
              : tone === 'blue'
                ? colors.blue
                : tone === 'glass'
                  ? 'rgba(255,255,255,.12)'
                  : colors.white,
          opacity: busy ? 0.65 : pressed ? 0.8 : 1,
        },
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={ink} /> : null}
      <Text
        style={[
          {
            color: ink,
            fontFamily: fonts.heading,
            fontSize: px(compact ? 23 : 31),
            lineHeight: px(compact ? 29 : 39),
            flexShrink: 1,
            textAlign: 'center',
          },
          textStyle,
        ]}
      >
        {label}
      </Text>
      {icon ? <Icon name={icon} color={ink} size={px(34)} /> : null}
    </Pressable>
  );
}
export function IconButton({
  name,
  label,
  onPress,
  testID,
  dark = false,
  size = 64,
  disabled = false,
  orange = false,
}: {
  name: IconName;
  label: string;
  onPress: () => void;
  testID?: string;
  dark?: boolean;
  size?: number;
  disabled?: boolean;
  orange?: boolean;
}) {
  const { px } = useMetrics();
  const dim = Math.max(48, px(size));
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        width: dim,
        height: dim,
        borderRadius: orange ? dim / 2 : px(18),
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: orange ? colors.orange : dark ? 'rgba(255,255,255,.14)' : colors.light,
        opacity: disabled ? 0.35 : pressed ? 0.65 : 1,
      })}
    >
      <Icon name={name} size={px(32)} color={orange || dark ? colors.white : colors.blue} />
    </Pressable>
  );
}
export function Logo({ size = 60 }: { size?: number }) {
  const { px } = useMetrics();
  return (
    <View
      style={{
        width: px(size),
        height: px(size),
        overflow: 'hidden',
        borderRadius: px(size * 0.27),
        backgroundColor: colors.blue,
      }}
    >
      <Image
        source={assets.logo}
        contentFit="contain"
        style={{ width: '170%', height: '170%', marginLeft: '-35%', marginTop: '-35%' }}
        accessibilityLabel="Pick Chick"
      />
    </View>
  );
}
export function Language({
  locale,
  onChange,
}: {
  locale: Locale;
  onChange: (locale: Locale) => void;
}) {
  const { px } = useMetrics();
  return (
    <View
      style={{
        flexDirection: 'row',
        padding: 4,
        borderRadius: px(20),
        backgroundColor: 'rgba(255,255,255,.14)',
        gap: 2,
      }}
    >
      {(['kk', 'ru'] as const).map((value) => (
        <Pressable
          key={value}
          testID={`kiosk-language-${value}`}
          accessibilityRole="button"
          accessibilityLabel={value === 'kk' ? 'Қазақша' : 'Русский'}
          accessibilityState={{ selected: value === locale }}
          onPress={() => onChange(value)}
          style={{
            minWidth: Math.max(52, px(66)),
            minHeight: Math.max(48, px(56)),
            paddingHorizontal: px(12),
            borderRadius: px(16),
            justifyContent: 'center',
            alignItems: 'center',
            backgroundColor: value === locale ? colors.white : 'transparent',
          }}
        >
          <Text
            style={{
              color: value === locale ? colors.blue : colors.white,
              fontFamily: fonts.heading,
              fontSize: px(22),
            }}
          >
            {value === 'kk' ? 'KZ' : 'RU'}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
export interface ScreenContext {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  onCancel: () => void;
  onHelp: () => void;
}
export function Header({
  locale,
  setLocale,
  onCancel,
  onHelp,
  back,
  title,
  mode,
  minimal = false,
  transparent = false,
}: ScreenContext & {
  back?: () => void;
  title?: string;
  mode?: string;
  minimal?: boolean;
  transparent?: boolean;
}) {
  const { px, width } = useMetrics();
  const safe = useSafeAreaInsets();
  const t = copy(locale);
  return (
    <View
      style={{
        backgroundColor: transparent ? 'transparent' : colors.blue,
        paddingTop: safe.top,
        paddingLeft: Math.max(safe.left, px(24)),
        paddingRight: Math.max(safe.right, px(24)),
      }}
    >
      <View
        style={{
          minHeight: px(104),
          paddingVertical: px(16),
          flexDirection: 'row',
          alignItems: 'center',
          gap: px(18),
        }}
      >
        {back ? <IconButton name="arrow-back" label={t.back} dark onPress={back} /> : <Logo />}
        <View style={{ flex: 1, minWidth: 0 }}>
          {minimal ? null : title ? (
            <Heading size={28} color={colors.white}>
              {title}
            </Heading>
          ) : (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: px(14) }}>
              <Logo />
              {mode && width >= 600 ? (
                <View
                  style={{
                    minHeight: px(52),
                    borderRadius: px(26),
                    backgroundColor: 'rgba(255,255,255,.16)',
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingHorizontal: px(18),
                    gap: px(9),
                    flexShrink: 1,
                  }}
                >
                  <View
                    style={{
                      width: px(9),
                      height: px(9),
                      borderRadius: 5,
                      backgroundColor: colors.orange,
                    }}
                  />
                  <Body style={{ fontFamily: fonts.heading, color: colors.white, flexShrink: 1 }}>
                    {mode}
                  </Body>
                </View>
              ) : null}
            </View>
          )}
        </View>
        {!minimal ? (
          <IconButton name="help-circle-outline" label={t.help} dark onPress={onHelp} />
        ) : null}
        {!minimal ? (
          <IconButton
            name="close"
            label={t.cancel}
            testID="kiosk-cancel-open"
            dark
            onPress={onCancel}
          />
        ) : null}
        <Language locale={locale} onChange={setLocale} />
      </View>
    </View>
  );
}
export function Footer({
  children,
  blue = false,
  style,
  testID,
}: {
  children: ReactNode;
  blue?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const safe = useSafeAreaInsets();
  const { px } = useMetrics();
  return (
    <View
      testID={testID}
      style={[
        {
          paddingTop: px(22),
          paddingBottom: Math.max(safe.bottom, px(26)),
          paddingLeft: Math.max(safe.left, px(24)),
          paddingRight: Math.max(safe.right, px(24)),
          backgroundColor: blue ? colors.blue : colors.white,
          borderTopWidth: blue ? 0 : 1,
          borderColor: colors.border,
          gap: px(18),
        },
        style,
      ]}
    >
      {blue ? <BluePattern footer /> : null}
      {children}
    </View>
  );
}
export function Stepper({
  quantity,
  onMinus,
  onPlus,
  min = 0,
  max = 99,
  dark = false,
  prefix,
  disabled = false,
}: {
  quantity: number;
  onMinus: () => void;
  onPlus: () => void;
  min?: number;
  max?: number;
  dark?: boolean;
  prefix: string;
  disabled?: boolean;
}) {
  const { px } = useMetrics();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: px(10) }}>
      <IconButton
        name="remove"
        label="−"
        size={72}
        dark={dark}
        disabled={disabled || quantity <= min}
        onPress={onMinus}
        testID={`${prefix}-minus`}
      />
      <Heading
        size={28}
        color={dark ? colors.white : colors.ink}
        style={{ minWidth: px(36), textAlign: 'center' }}
        testID={`${prefix}-quantity`}
      >
        {quantity}
      </Heading>
      <IconButton
        name="add"
        label="+"
        size={72}
        dark={dark}
        disabled={disabled || quantity >= max}
        onPress={onPlus}
        testID={`${prefix}-plus`}
      />
    </View>
  );
}
export function Dialog({
  visible,
  children,
  onClose,
  testID,
  dark = false,
  footer,
  placement = 'center',
}: {
  visible: boolean;
  children: ReactNode;
  onClose: () => void;
  testID?: string;
  dark?: boolean;
  footer?: ReactNode;
  placement?: 'center' | 'bottom';
}) {
  const { px, height } = useMetrics();
  const safe = useSafeAreaInsets();
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View
        style={{
          flex: 1,
          backgroundColor: 'rgba(2,12,35,.72)',
          justifyContent: placement === 'bottom' ? 'flex-end' : 'center',
          padding: px(30),
          paddingTop: Math.max(safe.top, px(30)),
          paddingBottom: Math.max(safe.bottom, px(30)),
        }}
      >
        <View
          accessibilityViewIsModal
          testID={testID}
          style={{
            width: '100%',
            maxWidth: placement === 'bottom' ? 960 : 760,
            maxHeight:
              placement === 'bottom' ? height * 0.8 : height - Math.max(60, safe.top + safe.bottom),
            alignSelf: 'center',
            borderRadius: px(32),
            backgroundColor: dark ? colors.dark : colors.white,
            overflow: 'hidden',
          }}
        >
          <ScrollView
            keyboardShouldPersistTaps="handled"
            style={{ flexShrink: 1 }}
            contentContainerStyle={{ padding: px(36), gap: px(26) }}
          >
            {children}
          </ScrollView>
          {footer ? (
            <View style={{ paddingHorizontal: px(30), paddingBottom: px(30), paddingTop: px(10) }}>
              {footer}
            </View>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}
export const layout = StyleSheet.create({
  screen: { flex: 1, minHeight: 0, backgroundColor: colors.background },
  row: { flexDirection: 'row', alignItems: 'center' },
  spread: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  grow: { flex: 1, minHeight: 0 },
});
