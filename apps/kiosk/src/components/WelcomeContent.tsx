import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { copy, type Locale } from '../i18n';
import { useMetrics } from '../theme';
import { Body, Button, Heading, Language, Logo, Wrapper } from './UI';
export function WelcomeContent({
  locale,
  onLocale,
  onStart,
  busy,
}: {
  locale: Locale;
  onLocale: (v: Locale) => void;
  onStart: () => void;
  busy: boolean;
}) {
  const { px, landscape } = useMetrics();
  const safe = useSafeAreaInsets();
  const t = copy(locale);
  return (
    <>
      <Pressable
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        onPress={onStart}
        disabled={busy}
        style={StyleSheet.absoluteFill}
      />
      <View
        style={{
          paddingTop: Math.max(safe.top, px(36)),
          paddingHorizontal: px(36),
          flexDirection: 'row',
          justifyContent: 'space-between',
        }}
      >
        <Logo size="hero" />
        <Language locale={locale} onChange={onLocale} tone="inverse" />
      </View>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: 'flex-end',
          paddingHorizontal: px(48),
          paddingBottom: Math.max(safe.bottom, px(landscape ? 24 : 60)),
          paddingTop: px(28),
          gap: px(24),
        }}
      >
        <Heading size="hero" tone="inverse" align="center">
          PICK YOUR{'\n'}PEAK
        </Heading>
        <Body tone="inverse" align="center">
          {t.attractSub}
        </Body>
        <Button
          label={t.start}
          icon="arrow-forward"
          testID="kiosk-start"
          busy={busy}
          onPress={onStart}
          size="hero"
          fullWidth
        />
        <Wrapper align="center">
          <Body tone="inverse" variant="caption">
            {t.tapAnywhere}
          </Body>
        </Wrapper>
      </ScrollView>
    </>
  );
}
