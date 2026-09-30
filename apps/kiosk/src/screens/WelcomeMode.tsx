import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { KioskModel } from '../model';
import { assets } from '../assets';
import { copy } from '../i18n';
import { colors, fonts, useMetrics } from '../theme';
import {
  Body,
  Button,
  Header,
  Heading,
  Language,
  Logo,
  layout,
  type ScreenContext,
} from '../components/UI';
import { Hero } from '../components/Hero';
import { LightBackground } from '../components/PatternBackground';
export function WelcomeScreen({ model, context }: { model: KioskModel; context: ScreenContext }) {
  const { px, landscape } = useMetrics();
  const safe = useSafeAreaInsets();
  const t = copy(context.locale);
  return (
    <View testID="kiosk-screen-welcome" style={[layout.screen, { backgroundColor: colors.dark }]}>
      <Hero />
      <Pressable
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        onPress={() => void model.start()}
        style={StyleSheet.absoluteFill}
      />
      <View
        style={{
          paddingTop: Math.max(safe.top, px(44)),
          paddingHorizontal: Math.max(safe.left, px(44)),
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
        }}
      >
        <Logo size={96} />
        <Language locale={context.locale} onChange={context.setLocale} />
      </View>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: 'flex-end',
          paddingHorizontal: px(56),
          paddingTop: px(32),
          paddingBottom: Math.max(safe.bottom, px(landscape ? 32 : 72)),
          gap: px(28),
        }}
      >
        <View>
          <Heading
            size={landscape ? 72 : 88}
            color={colors.white}
            style={{ textAlign: 'center', lineHeight: px(landscape ? 72 : 86) }}
          >
            PICK YOUR{'\n'}PEAK
          </Heading>
          <Body
            style={{
              color: colors.white,
              textAlign: 'center',
              fontFamily: fonts.medium,
              fontSize: px(26),
              marginTop: px(20),
            }}
          >
            {t.attractSub}
          </Body>
        </View>
        <Button
          label={t.start}
          icon="arrow-forward"
          testID="kiosk-start"
          busy={model.busy}
          onPress={() => void model.start()}
          style={{ minHeight: px(142), borderRadius: px(36) }}
          textStyle={{
            fontFamily: fonts.heavy,
            fontSize: px(50),
            lineHeight: px(59),
            letterSpacing: 1,
          }}
        />
        <Body style={{ color: 'rgba(255,255,255,.7)', textAlign: 'center' }}>{t.tapAnywhere}</Body>
      </ScrollView>
    </View>
  );
}
export function ModeScreen({ model, context }: { model: KioskModel; context: ScreenContext }) {
  const { px, landscape, height } = useMetrics();
  const safe = useSafeAreaInsets();
  const t = copy(context.locale);
  return (
    <View testID="kiosk-screen-mode" style={layout.screen}>
      <LightBackground />
      <Header
        {...context}
        back={() =>
          model.cart.length || model.unavailableCartLines.length
            ? context.onCancel()
            : void model.newGuest()
        }
        minimal
      />
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          paddingHorizontal: px(48),
          paddingTop: px(52),
          paddingBottom: Math.max(safe.bottom, px(48)),
          gap: px(38),
        }}
      >
        <Heading size={56}>{t.modeTitle}</Heading>
        <View style={{ flex: 1, flexDirection: landscape ? 'row' : 'column', gap: px(24) }}>
          {(['dine_in', 'takeaway'] as const).map((mode) => (
            <Pressable
              key={mode}
              testID={`kiosk-mode-${mode === 'dine_in' ? 'dine-in' : 'takeaway'}`}
              accessibilityRole="button"
              accessibilityLabel={`${mode === 'dine_in' ? t.here : t.togo}, ${mode === 'dine_in' ? t.hereSub : t.togoSub}`}
              disabled={model.busy}
              onPress={() => void model.setMode(mode)}
              style={({ pressed }) => ({
                flex: 1,
                minHeight: px(landscape ? 330 : height < 1100 ? 300 : 380),
                borderRadius: px(32),
                overflow: 'hidden',
                backgroundColor: mode === 'dine_in' ? colors.blue : colors.orange,
                opacity: pressed || model.busy ? 0.75 : 1,
                justifyContent: 'center',
                alignItems: 'center',
                padding: px(30),
                gap: px(18),
              })}
            >
              <Image
                source={mode === 'dine_in' ? assets.blue : assets.orange}
                contentFit="cover"
                style={StyleSheet.absoluteFill}
              />
              <LinearGradient
                colors={
                  mode === 'dine_in'
                    ? ['rgba(0,40,110,.66)', 'rgba(0,26,80,.88)']
                    : ['rgba(214,74,10,.5)', 'rgba(190,60,0,.8)']
                }
                style={StyleSheet.absoluteFill}
              />
              <Image
                source={
                  mode === 'dine_in'
                    ? require('../components/dine.svg')
                    : require('../components/takeaway.svg')
                }
                contentFit="contain"
                style={{ width: px(120), height: px(120) }}
              />
              <Heading size={52} color={colors.white} style={{ textAlign: 'center' }}>
                {mode === 'dine_in' ? t.here : t.togo}
              </Heading>
              <Body style={{ color: colors.white, fontFamily: fonts.medium, fontSize: px(24) }}>
                {mode === 'dine_in' ? t.hereSub : t.togoSub}
              </Body>
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}
