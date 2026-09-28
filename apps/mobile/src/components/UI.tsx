import { MotionPressable as Pressable } from './Motion';
import type { ReactNode } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type TextProps,
  type ViewStyle,
  type LayoutChangeEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { assets } from '../assets';
import type { ScreenProps } from '../model';
import { colors, font } from '../theme';

export type IconName = React.ComponentProps<typeof Ionicons>['name'];
export function Icon({
  name,
  size = 22,
  color = colors.text,
}: {
  name: IconName;
  size?: number;
  color?: string;
}) {
  return (
    <View
      pointerEvents="none"
      accessible={false}
      style={{
        width: size,
        height: size,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <Ionicons
        name={name}
        size={size}
        color={color}
        allowFontScaling={false}
        style={{ includeFontPadding: false, textAlign: 'center', textAlignVertical: 'center' }}
      />
    </View>
  );
}
// Exact 24×24 outlines from the supplied mobile v2 mockup. An image gives all
// four tabs the same optical box without platform icon-font baseline offsets.
export function TabIcon({
  name,
  color,
}: {
  name: 'menu' | 'events' | 'orders' | 'profile';
  color: string;
}) {
  const paths = {
    menu: '<path d="M3 6h18M3 12h18M3 18h12"/>',
    events: '<rect x="3" y="5" width="18" height="16" rx="4"/><path d="M8 3v4M16 3v4M3 11h18"/>',
    orders: '<path d="M6 2h12v20l-3-2-3 2-3-2-3 2V2z"/><path d="M9 7h6M9 11h6"/>',
    profile: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/>',
  };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
  return (
    <Image
      source={{ uri: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` }}
      style={{ width: 23, height: 23, flexShrink: 0 }}
      contentFit="contain"
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    />
  );
}
export function Body({
  children,
  muted = false,
  style,
  testID,
}: {
  children: ReactNode;
  muted?: boolean;
  style?: StyleProp<TextStyle>;
  testID?: string;
}) {
  return (
    <Text testID={testID} style={[styles.body, muted && styles.muted, style]}>
      {children}
    </Text>
  );
}
export function Heading({
  children,
  small = false,
  style,
  testID,
}: {
  children: ReactNode;
  small?: boolean;
  testID?: string;
  style?: StyleProp<TextStyle>;
}) {
  return (
    <Text
      testID={testID}
      accessibilityRole="header"
      style={[styles.heading, small && styles.headingSmall, style]}
    >
      {children}
    </Text>
  );
}
export function Caption({ children, style, ...props }: TextProps) {
  return (
    <Text {...props} style={[styles.caption, style]}>
      {children}
    </Text>
  );
}
export function Logo({ size = 40 }: { size?: number }) {
  return (
    <View style={[styles.logo, { width: size, height: size }]}>
      <Image
        source={assets.logo}
        style={{ width: size * 1.7, height: size * 1.7, margin: -size * 0.35 }}
        contentFit="cover"
        accessibilityLabel="Pick Chick"
      />
    </View>
  );
}
export function Button({
  title,
  onPress,
  secondary = false,
  disabled = false,
  icon,
  testID,
  accessibilityLabel,
  style,
  textStyle,
}: {
  title: string;
  onPress?: () => void;
  secondary?: boolean;
  disabled?: boolean;
  icon?: IconName;
  testID?: string;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
}) {
  return (
    <Pressable
      feedback="scale"
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.button,
        secondary && styles.secondaryButton,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
        style,
      ]}
    >
      {icon ? <Icon name={icon} color={secondary ? colors.text : colors.orangeInk} /> : null}
      <Text style={[styles.buttonText, secondary && styles.secondaryButtonText, textStyle]}>
        {title}
      </Text>
    </Pressable>
  );
}
export function IconButton({
  name,
  color,
  label,
  onPress,
  style,
  testID,
  disabled = false,
}: {
  name: IconName;
  color?: string;
  label: string;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.iconButton,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
        style,
      ]}
    >
      <Icon name={name} color={color} />
    </Pressable>
  );
}
/** Cart-style close control shared by every sheet and product screen. */
export function CloseButton({
  label,
  onPress,
  testID,
  style,
}: {
  label: string;
  onPress(): void;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <IconButton
      name="close"
      color={colors.text}
      label={label}
      onPress={onPress}
      testID={testID}
      style={[style, { backgroundColor: colors.surface, width: 48, height: 48, borderRadius: 24 }]}
    />
  );
}
export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}
export function Row({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.row, style]}>{children}</View>;
}
export function Notice({
  title,
  children,
  warning = false,
}: {
  title?: string;
  children: ReactNode;
  warning?: boolean;
}) {
  return (
    <View style={[styles.notice, warning && styles.warning]}>
      <Icon
        name={warning ? 'information-circle-outline' : 'sparkles-outline'}
        color={warning ? colors.warning : colors.text}
      />
      <View style={styles.flex}>
        {title ? <Body style={styles.noticeTitle}>{title}</Body> : null}
        <Body style={styles.noticeBody}>{children}</Body>
      </View>
    </View>
  );
}
export function ReviewBadge() {
  return (
    <View style={styles.reviewBadge}>
      <Icon name="color-palette-outline" size={16} color={colors.warning} />
      <Caption style={{ color: colors.warning, flex: 1 }}>
        Просмотр дизайна · пример, не операция
      </Caption>
    </View>
  );
}
export function Page({
  props,
  title,
  children,
  footer,
  noBack = false,
  header,
}: {
  props: ScreenProps;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  noBack?: boolean;
  header?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView
      testID={`screen-${props.screenId}`}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[styles.page, { paddingTop: props.inSheet ? 0 : insets.top }]}
    >
      {header ?? (
        <Row style={styles.pageHeader}>
          {noBack ? null : <IconButton name="chevron-back" label="Назад" onPress={props.goBack} />}
          <Heading small style={styles.flex}>
            {title}
          </Heading>
          <Logo size={34} />
        </Row>
      )}
      <ScrollView
        testID={`scroll-${props.screenId}`}
        style={styles.scroll}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[
          styles.pageContent,
          {
            paddingBottom: footer
              ? 24
              : Math.max(28, insets.bottom + 16, (props.cartBottomInset ?? 0) + 16),
          },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {props.preview ? <ReviewBadge /> : null}
        {children}
      </ScrollView>
      {footer ? <BottomActions safeArea={!props.inTabLayout}>{footer}</BottomActions> : null}
    </KeyboardAvoidingView>
  );
}

// A sibling of the bounded scroll view: its measured height reserves space for
// dynamic text and safe-area insets, without an absolute overlay hiding content.
export function BottomActions({
  children,
  pointerEvents = 'auto',
  safeArea = true,
  onLayout,
  style,
}: {
  children: ReactNode;
  safeArea?: boolean;
  onLayout?: (event: LayoutChangeEvent) => void;
  pointerEvents?: 'auto' | 'box-none';
  style?: StyleProp<ViewStyle>;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View
      pointerEvents={pointerEvents}
      testID="bottom-actions"
      onLayout={onLayout}
      style={[styles.footer, { paddingBottom: Math.max(16, safeArea ? insets.bottom : 0) }, style]}
    >
      <View pointerEvents={pointerEvents} style={styles.footerContent}>
        {children}
      </View>
    </View>
  );
}
export function NavRow({
  title,
  subtitle,
  icon = 'chevron-forward',
  onPress,
  disabled = false,
  testID,
}: {
  title: string;
  subtitle?: string;
  icon?: IconName;
  onPress?: () => void;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      feedback="scale"
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      style={({ pressed }) => [styles.navRow, pressed && styles.pressed]}
    >
      <View style={styles.flex}>
        <Body style={{ fontFamily: font.bold }}>{title}</Body>
        {subtitle ? <Caption style={{ marginTop: 5 }}>{subtitle}</Caption> : null}
      </View>
      <Icon name={disabled ? 'lock-closed-outline' : icon} color={colors.muted} />
    </Pressable>
  );
}
export function Empty({
  icon = 'bag-handle-outline',
  title,
  detail,
  action,
}: {
  icon?: IconName;
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}>
        <Icon name={icon} size={32} color={colors.accent} />
      </View>
      <Heading small style={{ textAlign: 'center' }}>
        {title}
      </Heading>
      <Body muted style={{ textAlign: 'center', maxWidth: 360, fontSize: 15, lineHeight: 23 }}>
        {detail}
      </Body>
      {action}
    </View>
  );
}
export function Loading({ title = 'Загружаем меню' }: { title?: string }) {
  return (
    <View style={styles.empty}>
      <ActivityIndicator size="large" color={colors.accent} />
      <Body muted>{title}</Body>
    </View>
  );
}
export function Pill({ children }: { children: ReactNode }) {
  return (
    <View style={styles.pill}>
      <Caption style={{ color: colors.text, fontFamily: font.bold }}>{children}</Caption>
    </View>
  );
}
export function SummaryRow({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <Row style={styles.summaryRow}>
      <Body muted={!strong} style={styles.flex}>
        {label}
      </Body>
      <Body
        style={[
          styles.summaryValue,
          strong && { fontFamily: font.bold, fontSize: 22, lineHeight: 30 },
        ]}
      >
        {value}
      </Body>
    </Row>
  );
}
export function MinorMoney(value: string | bigint): string {
  const minor = BigInt(value);
  const whole = minor / 100n;
  const fraction = minor % 100n;
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${grouped}${fraction ? `,${fraction.toString().padStart(2, '0')}` : ''} ₸`;
}
export const styles = StyleSheet.create({
  page: { flex: 1, minHeight: 0, backgroundColor: colors.background },
  scroll: { flex: 1, minHeight: 0 },
  pageHeader: {
    width: '100%',
    maxWidth: 760,
    alignSelf: 'center',
    flexShrink: 0,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 16,
    gap: 8,
  },
  pageContent: {
    paddingHorizontal: 18,
    gap: 20,
    flexGrow: 1,
    width: '100%',
    maxWidth: 760,
    alignSelf: 'center',
  },
  body: { fontFamily: font.body, color: colors.text, fontSize: 16, lineHeight: 24 },
  muted: { color: colors.muted },
  heading: {
    fontFamily: font.display,
    color: colors.text,
    fontSize: 34,
    lineHeight: 44,
    letterSpacing: -0.6,
  },
  headingSmall: { fontSize: 24, lineHeight: 32 },
  caption: { fontFamily: font.body, color: colors.muted, fontSize: 13, lineHeight: 19 },
  logo: { overflow: 'hidden', borderRadius: 12, backgroundColor: '#0047BB' },
  flex: { flex: 1, minWidth: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  card: {
    borderRadius: 20,
    backgroundColor: colors.surface,
    padding: 20,
    gap: 14,
    borderWidth: 1,
    borderColor: colors.border,
  },
  button: {
    backgroundColor: colors.accent,
    minHeight: 54,
    borderRadius: 16,
    paddingHorizontal: 18,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  buttonText: {
    color: colors.orangeInk,
    fontFamily: font.heading,
    fontSize: 18,
    lineHeight: 25,
    textAlign: 'center',
    flexShrink: 1,
    minWidth: 0,
  },
  secondaryButton: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  secondaryButtonText: { color: colors.text },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.72 },
  iconButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  notice: {
    borderRadius: 16,
    padding: 16,
    backgroundColor: '#122E60',
    flexDirection: 'row',
    gap: 12,
    alignItems: 'flex-start',
  },
  warning: { backgroundColor: colors.warningSurface },
  noticeTitle: { fontFamily: font.bold, marginBottom: 4 },
  noticeBody: { fontSize: 14, lineHeight: 22 },
  reviewBadge: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    backgroundColor: colors.warningSurface,
    padding: 10,
    borderRadius: 10,
  },
  navRow: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  footer: {
    flexShrink: 0,
    padding: 18,
    backgroundColor: colors.background,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: 10,
  },
  footerContent: { width: '100%', maxWidth: 724, alignSelf: 'center', gap: 10 },
  summaryValue: {
    flexShrink: 1,
    maxWidth: '60%',
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  empty: { flex: 1, paddingVertical: 28, alignItems: 'center', justifyContent: 'center', gap: 16 },
  emptyIcon: {
    width: 72,
    height: 72,
    borderRadius: 24,
    backgroundColor: colors.raised,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  pill: {
    backgroundColor: colors.raised,
    borderRadius: 24,
    paddingHorizontal: 12,
    paddingVertical: 7,
    alignSelf: 'flex-start',
  },
  summaryRow: { paddingVertical: 10, justifyContent: 'space-between' },
  input: {
    fontFamily: font.body,
    fontSize: 16,
    lineHeight: 24,
    backgroundColor: colors.surface,
    borderRadius: 16,
    minHeight: 56,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: colors.text,
  },
});
