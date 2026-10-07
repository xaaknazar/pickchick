import { View } from 'react-native';
import { useMetrics } from '../theme';
import { money } from '../cart';
import { Body, Heading, Icon, Wrapper } from './UI';
import { PaymentQR } from './PaymentQR';
export function PaymentStatus({
  state,
  title,
  total,
  reference,
  message,
  qrPayload,
}: {
  state: 'waiting' | 'unknown' | 'declined';
  title: string;
  total: string;
  reference: string;
  message: string;
  qrPayload?: string | null;
}) {
  const { px } = useMetrics();
  return (
    <Wrapper align="center" gap={24}>
      {qrPayload ? (
        <PaymentQR payload={qrPayload} label="Kaspi QR" />
      ) : (
        <View
          style={{
            width: px(108),
            height: px(108),
            borderRadius: 24,
            backgroundColor: state === 'unknown' ? '#FFF0E5' : '#E8EFFC',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon
            name={
              state === 'unknown'
                ? 'time-outline'
                : state === 'declined'
                  ? 'close-circle-outline'
                  : 'card-outline'
            }
            size="large"
            tone="brand"
          />
        </View>
      )}
      <Heading size="title" align="center">
        {title}
      </Heading>
      <Heading size="display" tone="brand">
        {money(total)}
      </Heading>
      <Body tone="muted" align="center">
        {reference}
      </Body>
      <Wrapper maxWidth={700}>
        <Body align="center" tone="muted">
          {message}
        </Body>
      </Wrapper>
    </Wrapper>
  );
}
