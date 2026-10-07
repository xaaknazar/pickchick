import { Image } from 'expo-image';
import { Pressable, View } from 'react-native';
import { copy, type Locale } from '../i18n';
import { colors, useMetrics } from '../theme';
import { Body, Heading, Icon, Wrapper } from './UI';
export function DiningModeCard({
  mode,
  locale,
  busy,
  onSelect,
}: {
  mode: 'dine_in' | 'takeaway';
  locale: Locale;
  busy: boolean;
  onSelect: () => void;
}) {
  const { px, landscape } = useMetrics();
  const t = copy(locale);
  const here = mode === 'dine_in';
  return (
    <Pressable
      testID={'kiosk-mode-' + (here ? 'dine-in' : 'takeaway')}
      accessibilityRole="button"
      accessibilityState={{ disabled: busy }}
      disabled={busy}
      onPress={onSelect}
      style={({ pressed }) => ({
        minHeight: px(landscape ? 260 : 250),
        borderRadius: 20,
        backgroundColor: here ? colors.blue : colors.white,
        borderWidth: here ? 0 : 1,
        borderColor: colors.border,
        padding: px(32),
        justifyContent: 'center',
        opacity: pressed || busy ? 0.8 : 1,
      })}
    >
      <Wrapper dir="row" align="center" gap={28}>
        <View
          style={{
            width: px(116),
            height: px(116),
            backgroundColor: here ? 'rgba(255,255,255,.12)' : colors.blue,
            borderRadius: 20,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Image
            accessible={false}
            accessibilityLabel=""
            source={here ? require('./dine.svg') : require('./takeaway.svg')}
            contentFit="contain"
            style={{ width: px(86), height: px(86) }}
          />
        </View>
        <Wrapper flex={1} gap={8}>
          <Heading size="title" tone={here ? 'inverse' : 'default'}>
            {here ? t.here : t.togo}
          </Heading>
          <Body tone={here ? 'inverse' : 'muted'}>{here ? t.hereSub : t.togoSub}</Body>
        </Wrapper>
        <Icon name="arrow-forward" tone={here ? 'inverse' : 'brand'} />
      </Wrapper>
    </Pressable>
  );
}
