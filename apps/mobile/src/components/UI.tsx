import type { ReactNode } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
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
  return <Ionicons name={name} size={size} color={color} />;
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
export function Caption({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<TextStyle>;
}) {
  return <Text style={[styles.caption, style]}>{children}</Text>;
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
  style,
}: {
  title: string;
  onPress?: () => void;
  secondary?: boolean;
  disabled?: boolean;
  icon?: IconName;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.button,
        secondary && styles.secondaryButton,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
        style,
      ]}
    >
      {icon ? <Icon name={icon} color={secondary ? colors.text : colors.white} /> : null}
      <Text style={[styles.buttonText, secondary && styles.secondaryButtonText]}>{title}</Text>
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
}: {
  name: IconName;
  color?: string;
  label: string;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [styles.iconButton, pressed && styles.pressed, style]}
    >
      <Icon name={name} color={color} />
    </Pressable>
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
      <Caption style={{ color: colors.warning }}>Просмотр дизайна · пример, не операция</Caption>
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
      style={[styles.page, { paddingTop: insets.top }]}
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
          { paddingBottom: footer ? 24 : Math.max(28, insets.bottom + 16) },
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
  safeArea = true,
  style,
}: {
  children: ReactNode;
  safeArea?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View
      testID="bottom-actions"
      style={[styles.footer, { paddingBottom: Math.max(16, safeArea ? insets.bottom : 0) }, style]}
    >
      {children}
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
        <Icon name={icon} size={40} color={colors.accent} />
      </View>
      <Heading style={{ textAlign: 'center' }}>{title}</Heading>
      <Body muted style={{ textAlign: 'center' }}>
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
      <Body style={strong ? { fontFamily: font.bold, fontSize: 22 } : undefined}>{value}</Body>
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
  pageHeader: { flexShrink: 0, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16, gap: 8 },
  pageContent: { paddingHorizontal: 18, gap: 20, flexGrow: 1 },
  body: { fontFamily: font.body, color: colors.text, fontSize: 16, lineHeight: 24 },
  muted: { color: colors.muted },
  heading: {
    fontFamily: font.display,
    color: colors.text,
    fontSize: 34,
    lineHeight: 39,
    letterSpacing: -0.6,
  },
  headingSmall: { fontSize: 24, lineHeight: 29 },
  caption: { fontFamily: font.body, color: colors.muted, fontSize: 13, lineHeight: 19 },
  logo: { overflow: 'hidden', borderRadius: 12, backgroundColor: '#0047BB' },
  flex: { flex: 1 },
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
    color: colors.white,
    fontFamily: font.heading,
    fontSize: 18,
    lineHeight: 25,
    textAlign: 'center',
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
  empty: { flex: 1, paddingVertical: 40, alignItems: 'center', justifyContent: 'center', gap: 20 },
  emptyIcon: {
    width: 96,
    height: 96,
    borderRadius: 32,
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
