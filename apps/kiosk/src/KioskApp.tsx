import { useCallback, useEffect, useState } from 'react';
import { EnrollmentScreen } from './screens/EnrollmentScreen';
import { commercialKioskEnabled } from './commercial-api';
import { commercialKioskEnrollmentPresent } from './storage';
import { BootState } from './components/BootState';
import { GuestScreen } from './screens/GuestScreen';
export function KioskApp() {
  const [enrolled, setEnrolled] = useState<boolean | null>(commercialKioskEnabled ? null : true);
  const [failed, setFailed] = useState(false);
  const check = useCallback(async () => {
    setFailed(false);
    try {
      setEnrolled(await commercialKioskEnrollmentPresent());
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    if (commercialKioskEnabled) void check();
  }, [check]);
  if (enrolled === false) return <EnrollmentScreen onComplete={() => setEnrolled(true)} />;
  if (enrolled === null)
    return (
      <BootState
        message={
          failed ? 'Не удалось прочитать настройку устройства. Пригласите сотрудника.' : undefined
        }
        onRetry={failed ? () => void check() : undefined}
      />
    );
  return <GuestScreen />;
}
export default KioskApp;
