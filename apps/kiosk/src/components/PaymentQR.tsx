import { useMemo } from 'react';
import { Image } from 'expo-image';
import { paymentQrSvg } from '../qr';

export function PaymentQR({
  payload,
  size,
  label,
}: {
  payload: string;
  size: number;
  label: string;
}) {
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
