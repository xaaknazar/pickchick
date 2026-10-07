import { useState } from 'react';
import { provisionCommercialKiosk } from '../storage';
import { enrollmentCredentialsValid } from '../enrollment';
import type { Locale } from '../i18n';
import { EnrollmentForm } from '../components/EnrollmentForm';
export function EnrollmentScreen({ onComplete }: { onComplete(): void }) {
  const [locale, setLocale] = useState<Locale>('ru');
  const [deviceId, setDeviceId] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const valid = enrollmentCredentialsValid(deviceId.trim(), key);
  const enroll = async () => {
    if (busy || !valid) return;
    setBusy(true);
    setError(false);
    try {
      await provisionCommercialKiosk(deviceId.trim(), key);
      setDeviceId('');
      setKey('');
      onComplete();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <EnrollmentForm
      locale={locale}
      onLocale={setLocale}
      deviceId={deviceId}
      onDeviceId={setDeviceId}
      deviceKey={key}
      onDeviceKey={setKey}
      busy={busy}
      error={error}
      valid={valid}
      onSubmit={() => void enroll()}
    />
  );
}
