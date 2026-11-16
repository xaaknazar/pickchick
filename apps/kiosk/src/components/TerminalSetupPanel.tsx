import { Text, TextInput, View } from 'react-native';
import type { Locale } from '../i18n';
import type { TerminalSetupView } from '../model';
import { terminalCopy, terminalResultText } from '../terminalCopy';
import { colors, fonts, useMetrics } from '../theme';
import { Body, fixedText } from './Body';
import { Button } from './Button';
import { Heading } from './Heading';
import { Wrapper } from './Wrapper';
/** Results that are good news; the others are shown as a problem to fix. */
const GOOD = ['linked', 'ok', 'unlinked'];
/**
 * Staff setup of the kiosk's own Kaspi Smart POS (ADR-0018), inside the white staff dialog after
 * the staff code: the terminal IP → «Подключить» → «Нажмите «Разрешить» на терминале» while the
 * terminal asks → the linked terminal (ID, serial, IP) with «Проверить связь» and «Отвязать».
 * The token is never shown.
 */
export function TerminalSetupPanel({
  view,
  host,
  onHostChange,
  locale,
  busy = false,
  onLink,
  onCheck,
  onUnlink,
}: {
  view: TerminalSetupView;
  host: string;
  onHostChange: (value: string) => void;
  locale: Locale;
  busy?: boolean;
  onLink: () => void;
  onCheck: () => void;
  onUnlink: () => void;
}) {
  const { px } = useMetrics();
  const t = terminalCopy(locale);
  const link = view.link;
  const good = view.result !== null && GOOD.includes(view.result);
  return (
    <Wrapper gap={18} testID="kiosk-terminal-setup">
      <Heading size="title">{view.confirming ? t.confirmTitle : t.setupTitle}</Heading>
      {view.confirming ? (
        <Body testID="kiosk-terminal-confirm">{t.confirmBody}</Body>
      ) : link ? (
        <Wrapper gap={8} testID="kiosk-terminal-linked">
          <Body variant="label" tone="muted">
            {t.linkedTitle}
          </Body>
          {[
            [t.terminalId, link.terminalId],
            [t.serial, link.serial],
            [t.ip, link.host],
          ].map(([label, value]) => (
            <View key={label} style={{ flexDirection: 'row', gap: px(12), flexWrap: 'wrap' }}>
              <Text
                {...fixedText}
                style={{ fontFamily: fonts.medium, fontSize: 18, color: colors.muted }}
              >
                {label}
              </Text>
              <Text
                {...fixedText}
                selectable
                style={{ fontFamily: fonts.heavy, fontSize: 18, color: colors.navy }}
              >
                {value}
              </Text>
            </View>
          ))}
          {!view.cloudLinked ? <Body tone="danger">{t.cloudPending}</Body> : null}
          {view.cloudLinked && !view.enabled ? <Body tone="muted">{t.disabled}</Body> : null}
        </Wrapper>
      ) : (
        <Wrapper gap={10}>
          <Body>{t.setupBody}</Body>
          <Body variant="label">{t.host}</Body>
          <TextInput
            {...fixedText}
            testID="kiosk-terminal-host"
            accessibilityLabel={t.host}
            value={host}
            onChangeText={(text) => onHostChange(text.replace(/[^\d.]/g, '').slice(0, 15))}
            editable={!busy}
            keyboardType="decimal-pad"
            inputMode="decimal"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            textContentType="none"
            placeholder="192.168.1.50"
            placeholderTextColor={colors.muted}
            maxLength={15}
            style={{
              minHeight: 56,
              padding: px(18),
              borderWidth: 2,
              borderColor:
                view.result === 'host' || view.result === 'unreachable'
                  ? colors.error
                  : colors.border,
              borderRadius: 16,
              fontFamily: fonts.heavy,
              fontSize: 24,
              color: colors.ink,
              backgroundColor: colors.white,
            }}
          />
        </Wrapper>
      )}
      {view.result && !view.confirming ? (
        <Body
          tone={good ? 'success' : 'danger'}
          accessibilityRole={good ? undefined : 'alert'}
          testID="kiosk-terminal-result"
        >
          {terminalResultText(t, view.result)}
        </Body>
      ) : null}
      {view.confirming ? null : link ? (
        <Wrapper gap={12}>
          <Button
            label={t.check}
            testID="kiosk-terminal-check"
            busy={busy}
            onPress={onCheck}
            fullWidth
          />
          <Button
            label={t.unlink}
            tone="secondary"
            testID="kiosk-terminal-unlink"
            disabled={busy}
            onPress={onUnlink}
            fullWidth
          />
        </Wrapper>
      ) : (
        <Button
          label={t.link}
          testID="kiosk-terminal-link"
          busy={busy}
          disabled={!host.trim()}
          onPress={onLink}
          fullWidth
        />
      )}
    </Wrapper>
  );
}
