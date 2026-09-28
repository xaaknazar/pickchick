import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ImageSourcePropType,
  type ViewStyle,
} from 'react-native';
import { Image } from 'expo-image';
import { Icon, type IconName } from '../components/UI';
import { colors, font } from '../theme';

export const arcade = {
  ink: '#070F21',
  panel: '#111F38',
  border: '#283C5B',
  white: '#F5F7FF',
  muted: '#A9BAD5',
  orange: '#FFAC70',
  blue: '#89B5FF',
};
export function useArcadeMotion() {
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => {
        if (live) setReduced(v);
      })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
  return reduced;
}
export function ArcadeBackdrop() {
  return (
    <View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { overflow: 'hidden' }]}
      accessible={false}
    >
      <View style={a.glowBlue} />
      <View style={a.glowOrange} />
      <View style={a.horizon} />
    </View>
  );
}
export function ArcadeButton({
  title,
  onPress,
  testID,
  secondary = false,
  disabled = false,
  icon,
}: {
  title: string;
  onPress(): void;
  testID?: string;
  secondary?: boolean;
  disabled?: boolean;
  icon?: IconName;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        a.button,
        secondary && a.secondary,
        disabled && { opacity: 0.45 },
        pressed && { transform: [{ scale: 0.98 }], opacity: 0.9 },
      ]}
    >
      {icon ? <Icon name={icon} size={20} color={secondary ? arcade.white : '#24130A'} /> : null}
      <Text style={[a.buttonLabel, secondary && { color: arcade.white }]}>{title}</Text>
    </Pressable>
  );
}
export function ArcadeIntro({
  cover,
  title,
  subtitle,
  steps,
  best,
  onStart,
  testID,
  disabled = false,
  children,
}: {
  cover: ImageSourcePropType;
  title: string;
  subtitle: string;
  steps: [IconName, string, string][];
  best: number;
  onStart(): void;
  testID: string;
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  const shade = 'linear-gradient(180deg, rgba(7,15,33,0) 28%, rgba(7,15,33,0.98) 100%)';
  const gradient = (
    Platform.OS === 'web' ? { backgroundImage: shade } : { experimental_backgroundImage: shade }
  ) as ViewStyle;
  return (
    <View style={a.intro}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={a.introScroll}>
        <View style={a.hero}>
          <Image
            source={cover}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            accessible={false}
          />
          <View style={[StyleSheet.absoluteFill, gradient]} />
          <View style={a.edition}>
            <View style={a.dot} />
            <Text style={a.editionText}>PICK CHICK ARCADE</Text>
          </View>
          <View style={a.heroCopy}>
            <Text style={a.heroTitle}>{title}</Text>
            <Text style={a.subtitle}>{subtitle}</Text>
          </View>
        </View>
        <View style={a.record}>
          <Icon name="trophy-outline" size={18} color={arcade.orange} />
          <Text style={a.recordLabel}>Твой рекорд</Text>
          <Text style={a.recordValue}>{best.toLocaleString('ru-RU')}</Text>
        </View>
        <View style={a.steps}>
          {steps.map(([icon, label, copy], i) => (
            <View style={a.step} key={label}>
              <View style={a.stepIcon}>
                <Icon name={icon} size={22} color={arcade.orange} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={a.stepLabel}>{label}</Text>
                <Text style={a.stepCopy}>{copy}</Text>
              </View>
              <Text style={a.stepNumber}>0{i + 1}</Text>
            </View>
          ))}
        </View>
        {children}
      </ScrollView>
      <View style={a.footer}>
        <ArcadeButton
          title="Поехали!"
          icon="play"
          testID={testID}
          disabled={disabled}
          onPress={onStart}
        />
        <Text style={a.caption}>Личный рекорд на устройстве · очки без начисления Чиков</Text>
      </View>
    </View>
  );
}
/** Brief event feedback, never a continuous animation or source of gameplay time. */
export function ArcadeFeedback({
  event,
  text,
  reduced,
  danger = false,
}: {
  event: number | string;
  text: string;
  reduced: boolean;
  danger?: boolean;
}) {
  const value = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!text) return;
    value.setValue(1);
    const animation = Animated.sequence([
      Animated.delay(650),
      Animated.timing(value, { toValue: 0, duration: reduced ? 0 : 250, useNativeDriver: true }),
    ]);
    animation.start();
    return () => animation.stop();
  }, [event, text, reduced, value]);
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        a.feedback,
        {
          opacity: value,
          transform: [
            {
              translateY: reduced
                ? 0
                : value.interpolate({ inputRange: [0, 1], outputRange: [-8, 0] }),
            },
          ],
        },
      ]}
    >
      <View style={[a.feedbackPill, danger && { backgroundColor: '#7A3030' }]}>
        <Text style={a.feedbackText}>{text}</Text>
      </View>
    </Animated.View>
  );
}
export function ArcadeMetric({
  label,
  value,
  accent = false,
  testID,
}: {
  label: string;
  value: string | number;
  accent?: boolean;
  testID?: string;
}) {
  return (
    <View style={a.metric}>
      <Text style={a.metricLabel}>{label}</Text>
      <Text
        testID={testID}
        numberOfLines={1}
        adjustsFontSizeToFit
        style={[a.metricValue, accent && { color: arcade.orange }]}
      >
        {value}
      </Text>
    </View>
  );
}
const a = StyleSheet.create({
  intro: { flex: 1, minHeight: 0 },
  introScroll: {
    flexGrow: 1,
    gap: 16,
    paddingTop: 10,
    paddingBottom: 16,
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
  },
  hero: {
    width: '100%',
    aspectRatio: 1.4,
    minHeight: 225,
    maxHeight: 330,
    borderRadius: 26,
    overflow: 'hidden',
    backgroundColor: arcade.panel,
  },
  edition: {
    position: 'absolute',
    top: 14,
    left: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    borderRadius: 20,
    padding: 9,
    backgroundColor: '#070F21B8',
  },
  dot: { height: 6, width: 6, borderRadius: 3, backgroundColor: arcade.orange },
  editionText: { fontFamily: font.bold, fontSize: 10, letterSpacing: 1, color: arcade.white },
  heroCopy: { position: 'absolute', bottom: 10, left: 18, right: 18 },
  heroTitle: { fontFamily: font.display, fontSize: 30, lineHeight: 43, color: arcade.white },
  subtitle: {
    fontFamily: font.medium,
    fontSize: 14,
    lineHeight: 21,
    color: '#DEE7F5',
    maxWidth: 340,
  },
  record: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingHorizontal: 17,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: arcade.border,
    borderRadius: 16,
    backgroundColor: '#111F3890',
  },
  recordLabel: { flex: 1, fontFamily: font.medium, fontSize: 13, color: arcade.muted },
  recordValue: { fontFamily: font.display, fontSize: 22, lineHeight: 29, color: arcade.white },
  steps: { gap: 12 },
  step: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 7 },
  stepIcon: {
    width: 46,
    height: 46,
    borderRadius: 15,
    backgroundColor: '#FFAC7012',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepLabel: { fontFamily: font.bold, fontSize: 14, lineHeight: 20, color: arcade.white },
  stepCopy: { fontFamily: font.body, fontSize: 12, lineHeight: 18, color: arcade.muted },
  stepNumber: { fontFamily: font.display, fontSize: 22, color: '#577091' },
  footer: {
    gap: 9,
    paddingTop: 10,
    paddingBottom: 4,
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
  },
  caption: {
    fontFamily: font.medium,
    fontSize: 11,
    lineHeight: 17,
    color: arcade.muted,
    textAlign: 'center',
  },
  button: {
    minHeight: 56,
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 18,
    backgroundColor: arcade.orange,
    borderWidth: 1,
    borderColor: '#FFD7B5',
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondary: { backgroundColor: arcade.panel, borderColor: arcade.border },
  buttonLabel: { fontFamily: font.bold, fontSize: 16, lineHeight: 23, color: '#24130A' },
  glowBlue: {
    position: 'absolute',
    top: -160,
    right: -150,
    width: 450,
    height: 450,
    borderRadius: 225,
    backgroundColor: '#285EC012',
  },
  glowOrange: {
    position: 'absolute',
    bottom: -100,
    left: -150,
    width: 350,
    height: 350,
    borderRadius: 175,
    backgroundColor: `${colors.accent}08`,
  },
  horizon: {
    position: 'absolute',
    top: '43%',
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: '#718BB512',
  },
  feedback: { position: 'absolute', top: 12, left: 10, right: 10, zIndex: 4, alignItems: 'center' },
  feedbackPill: {
    backgroundColor: '#285077',
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#FFFFFF20',
  },
  feedbackText: { fontFamily: font.bold, fontSize: 14, color: arcade.white },
  metric: {
    flex: 1,
    backgroundColor: arcade.panel,
    borderRadius: 17,
    padding: 12,
    borderWidth: 1,
    borderColor: arcade.border,
  },
  metricLabel: {
    fontFamily: font.bold,
    fontSize: 10,
    lineHeight: 16,
    color: arcade.muted,
    letterSpacing: 0.8,
  },
  metricValue: { fontFamily: font.display, fontSize: 25, lineHeight: 34, color: arcade.white },
});
