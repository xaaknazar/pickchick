import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { copy, type Locale } from '../i18n';
import { colors, useMetrics } from '../theme';
import { Wrapper } from './Wrapper';
import { IconButton } from './IconButton';
import { Logo } from './Logo';
import { Language } from './Language';
import { Heading } from './Heading';
import { Body } from './Body';
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
}: ScreenContext & { back?: () => void; title?: string; mode?: string; minimal?: boolean }) {
  const { px } = useMetrics();
  const safe = useSafeAreaInsets();
  const t = copy(locale);
  return (
    <View
      style={{
        backgroundColor: colors.white,
        paddingTop: safe.top,
        paddingLeft: Math.max(safe.left, px(24)),
        paddingRight: Math.max(safe.right, px(24)),
        borderBottomWidth: 1,
        borderColor: colors.border,
      }}
    >
      <Wrapper dir="row" align="center" gap={18} paddingY={18}>
        {back ? <IconButton name="arrow-back" label={t.back} onPress={back} /> : <Logo />}
        <Wrapper flex={1} gap={4}>
          {title ? (
            <Heading size="section">{title}</Heading>
          ) : (
            <>
              <Heading size="card" tone="brand">
                PICK CHICK
              </Heading>
              {mode ? (
                <Body variant="caption" tone="muted">
                  {mode}
                </Body>
              ) : null}
            </>
          )}
        </Wrapper>
        {!minimal ? (
          <>
            <IconButton name="help-circle-outline" label={t.help} onPress={onHelp} />
            <IconButton
              name="close"
              label={t.cancel}
              testID="kiosk-cancel-open"
              onPress={onCancel}
            />
          </>
        ) : null}
        <Language locale={locale} onChange={setLocale} />
      </Wrapper>
    </View>
  );
}
