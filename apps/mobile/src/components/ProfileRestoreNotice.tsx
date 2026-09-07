import { useDemoAccount } from '../useDemoAccount';
import { Body, Button } from './UI';
import { View } from 'react-native';

/** Read failures must never look like a new guest account or erase a saved profile. */
export function ProfileRestoreNotice() {
  const demo = useDemoAccount();
  if (demo.ready || !demo.error) return null;
  return (
    <View testID="profile-restore-error" style={{ gap: 12, marginTop: 16 }}>
      <Body style={{ color: '#FFB0AB' }}>{demo.error}</Body>
      <Button
        title={demo.busy ? 'Восстанавливаем…' : 'Повторить чтение профиля'}
        testID="profile-restore-retry"
        secondary
        disabled={demo.busy}
        onPress={() => void demo.retryRestore()}
      />
    </View>
  );
}
