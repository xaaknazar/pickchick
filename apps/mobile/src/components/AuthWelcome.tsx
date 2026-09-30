import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  AppState,
  Easing,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type ViewStyle,
} from 'react-native';
import { Image } from 'expo-image';
import Constants from 'expo-constants';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MotionPressable as Pressable, useReducedMotion } from './Motion';
import { CloseButton } from './UI';
import { AuthButton, authColors } from './AuthLayout';
import { colors, font } from '../theme';
import type { ScreenProps } from '../model';
import { useAccount } from '../useAccount';
import { useAuthFlow } from '../auth-flow';

const art = [
  {
    source: require('../../assets/catalog-cutouts/fingers.png'),
    left: 0,
    top: 64,
    size: 132,
    rotation: '-10deg',
  },
  {
    source: require('../../assets/catalog-cutouts/burger.png'),
    left: 263,
    top: 54,
    size: 136,
    rotation: '12deg',
  },
  {
    source: require('../../assets/catalog-cutouts/signature-small.png'),
    left: 14,
    top: 300,
    size: 104,
    rotation: '-4deg',
  },
  {
    source: require('../../assets/catalog-cutouts/sauce-hot.png'),
    left: 279,
    top: 300,
    size: 96,
    rotation: '7deg',
  },
  {
    source: require('../../assets/catalog-cutouts/sauce.png'),
    left: 170,
    top: 384,
    size: 56,
    rotation: '12deg',
  },
];
export function AuthWelcome(props: ScreenProps) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const flow = useAuthFlow();
  const account = useAccount();
  const [active, setActive] = useState(AppState.currentState === 'active');
  const phase = useRef(new Animated.Value(0)).current;
  const scale = Math.min(1, (width - 16) / 393, Math.max(0.56, (height - 290) / 560));
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setActive(s === 'active'));
    return () => sub.remove();
  }, []);
  useEffect(() => {
    phase.setValue(0);
    if (reduced || !active) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(phase, {
          toValue: 1,
          duration: 2800,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
          isInteraction: false,
        }),
        Animated.timing(phase, {
          toValue: 0,
          duration: 2800,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
          isInteraction: false,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [phase, reduced, active]);
  const game =
    flow?.destination === 'pick-man' ||
    flow?.destination === 'pick-blocks' ||
    flow?.destination === 'M26';
  const subtitle =
    flow?.destination === 'M12'
      ? 'Чтобы оформить заказ и оплатить его через Kaspi'
      : game
        ? 'Чтобы играть в игры и участвовать в событиях'
        : 'Чтобы оформлять заказы, копить Чики и играть в игры';
  const glow =
    'radial-gradient(circle, rgba(0,71,187,0.9) 0%, rgba(0,71,187,0.3) 38%, rgba(4,20,58,0) 68%)';
  return (
    <View testID="auth-welcome" style={s.page}>
      <View style={s.header}>
        <CloseButton label="Закрыть вход" testID="auth-close" onPress={props.goBack} />
        <Pressable
          accessibilityRole="button"
          onPress={() => props.navigate('M31')}
          style={s.support}
        >
          <Text style={s.supportText}>Поддержка</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
        <View
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{ width: 393 * scale, height: 460 * scale, alignSelf: 'center' }}
        >
          <View
            style={{ width: 393, height: 460, transform: [{ scale }], transformOrigin: 'top left' }}
          >
            <View
              style={[
                s.glow,
                (Platform.OS === 'web'
                  ? { backgroundImage: glow }
                  : { experimental_backgroundImage: glow }) as ViewStyle,
              ]}
            />
            <View style={s.ring} />
            <View style={[s.ring, s.outerRing]} />
            <View style={s.mascot}>
              <Image
                source={require('../../assets/games/pick-man-chick.png')}
                contentFit="contain"
                style={StyleSheet.absoluteFill}
              />
              <View
                style={[
                  StyleSheet.absoluteFill,
                  (Platform.OS === 'web'
                    ? { backgroundImage: 'radial-gradient(circle, transparent 56%, #082860 72%)' }
                    : {
                        experimental_backgroundImage:
                          'radial-gradient(circle, transparent 56%, #082860 72%)',
                      }) as ViewStyle,
                ]}
              />
            </View>
            {art.map((item, i) => (
              <Animated.View
                key={i}
                style={{
                  position: 'absolute',
                  left: item.left,
                  top: item.top,
                  width: item.size,
                  height: item.size,
                  opacity: i === 4 ? 0.55 : 1,
                  transform: [
                    {
                      translateY: phase.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0, i % 2 ? 7 : -9],
                      }),
                    },
                    { rotate: item.rotation },
                  ],
                }}
              >
                <Image source={item.source} style={StyleSheet.absoluteFill} contentFit="contain" />
              </Animated.View>
            ))}
          </View>
        </View>
        <View style={s.copy}>
          <Text accessibilityRole="header" style={s.title}>
            Войдите в профиль
          </Text>
          <Text style={s.subtitle}>{subtitle}</Text>
          <View style={s.cta}>
            <AuthButton
              title="По номеру телефона"
              icon="phone-portrait-outline"
              testID="account-required-login"
              onPress={() =>
                props.navigate(
                  account.challenge &&
                    (account.pendingVerify || account.challenge.expiresAt > Date.now())
                    ? 'M03'
                    : 'M02',
                )
              }
            />
          </View>
        </View>
        <View style={[s.footer, { paddingBottom: Math.max(insets.bottom, 24) }]}>
          <Pressable
            accessibilityRole="link"
            onPress={() => props.navigate('M33')}
            style={s.legalButton}
          >
            <Text style={s.legal}>Правовые документы</Text>
          </Pressable>
          <Text style={s.version}>· Версия {Constants.expoConfig?.version ?? '0.1.0'}</Text>
        </View>
      </ScrollView>
    </View>
  );
}
const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: authColors.background },
  content: { flexGrow: 1, width: '100%', maxWidth: 480, alignSelf: 'center' },
  glow: { position: 'absolute', width: 460, height: 460, top: 8, left: -33 },
  ring: {
    position: 'absolute',
    width: 300,
    height: 300,
    left: 46,
    top: 88,
    borderRadius: 150,
    borderWidth: 1,
    borderColor: '#FFFFFF14',
  },
  outerRing: {
    width: 430,
    height: 430,
    left: -19,
    top: 23,
    borderRadius: 215,
    borderStyle: 'dashed',
    borderColor: '#FFFFFF10',
  },
  mascot: {
    position: 'absolute',
    left: 76,
    top: 118,
    width: 240,
    height: 240,
    borderRadius: 120,
    overflow: 'hidden',
  },
  header: {
    zIndex: 2,
    position: 'absolute',
    top: 16,
    left: 16,
    right: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  support: {
    height: 48,
    borderRadius: 24,
    paddingHorizontal: 18,
    justifyContent: 'center',
    backgroundColor: '#FFFFFF1A',
    borderColor: '#FFFFFF24',
    borderWidth: 1,
  },
  supportText: { fontFamily: font.medium, fontSize: 15, color: '#FFFFFF' },
  copy: { paddingHorizontal: 24, alignItems: 'center' },
  title: {
    fontFamily: font.display,
    fontSize: 32,
    lineHeight: 38,
    letterSpacing: -0.6,
    color: '#FFFFFF',
    textAlign: 'center',
  },
  subtitle: {
    marginTop: 10,
    fontFamily: font.body,
    fontSize: 16,
    lineHeight: 24,
    color: authColors.muted,
    maxWidth: 310,
    textAlign: 'center',
  },
  cta: {
    alignSelf: 'stretch',
    marginTop: 28,
    shadowColor: colors.accent,
    shadowOpacity: 0.25,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 10 },
  },
  phoneIcon: { position: 'absolute', top: 19, left: '16%' },
  footer: {
    flexGrow: 1,
    paddingTop: 32,
    justifyContent: 'center',
    flexDirection: 'row',
    alignItems: 'flex-end',
    flexWrap: 'wrap',
    gap: 10,
    paddingHorizontal: 24,
  },
  legalButton: { minHeight: 48, justifyContent: 'center' },
  legal: {
    fontFamily: font.body,
    fontSize: 12,
    color: authColors.muted,
    textDecorationLine: 'underline',
  },
  version: { fontFamily: font.body, fontSize: 12, color: authColors.muted, paddingVertical: 16 },
});
