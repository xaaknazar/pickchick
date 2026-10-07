import { useMemo } from 'react';
import { Image } from 'expo-image';
import { paymentQrSvg } from '../qr';
import { useMetrics } from '../theme';

export function PaymentQR({ payload, label }: { payload: string; label: string }) {
  const { px } = useMetrics();
  const size = px(320);
  const svg = useMemo(() => paymentQrSvg(payload), [payload]);
  if (!svg) return null;
  return (
    <Image
      testID="kiosk-payment-qr"
      accessibilityLabel={label}
      accessible
      source={{ uri: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}` }}
      contentFit="contain"
      style={{ width: size, height: size, backgroundColor: '#fff' }}
    />
  );
}
