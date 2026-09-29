import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Body, Caption, Card, Row, styles as ui } from './UI';
import { PaymentMark } from './PaymentChoice';
import { orderUI } from './OrderPresentation';
import { colors } from '../theme';
import { money } from '../domain';
import { kaspiStageCopy, type KaspiCheckoutView } from '../kaspi-checkout';

/** Status of one Kaspi invoice, exactly as reported by the server. */
export function KaspiPaymentStatus({
  view,
  phoneMasked,
}: {
  view: KaspiCheckoutView;
  phoneMasked: string | null;
}) {
  const copy = kaspiStageCopy(view, phoneMasked);
  const accent =
    copy.tone === 'success'
      ? colors.success
      : copy.tone === 'warning'
        ? colors.warning
        : colors.text;
  return (
    <Card style={styles.card}>
      <Row style={styles.head}>
        <PaymentMark method="kaspi" size={38} />
        <View style={styles.titles}>
          <Text
            testID={`kaspi-stage-${view.stage}`}
            accessibilityRole="header"
            style={[ui.body, orderUI.section, { color: accent }]}
          >
            {copy.title}
          </Text>
          <Caption>{money(view.total_minor)}</Caption>
        </View>
        {copy.tone === 'progress' ? (
          <ActivityIndicator accessibilityLabel="Ожидаем" color={colors.text} />
        ) : null}
      </Row>
      <Text style={[ui.body, orderUI.detail]} accessibilityLiveRegion="polite">
        {copy.body}
      </Text>
      <View style={styles.lines}>
        {view.lines.map((line, index) => (
          <Row key={index} style={styles.line}>
            <Body style={[orderUI.detail, styles.lineTitle]}>
              {line.quantity} × {line.title}
            </Body>
            <Body style={orderUI.detail}>{money(line.total_minor)}</Body>
          </Row>
        ))}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: 12 },
  head: { alignItems: 'center', gap: 12 },
  titles: { flex: 1, gap: 2 },
  lines: { gap: 4 },
  line: { justifyContent: 'space-between', gap: 12 },
  lineTitle: { flex: 1 },
});
