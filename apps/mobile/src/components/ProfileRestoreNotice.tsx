import { useAccount } from '../useAccount';
import { Body, Button } from './UI';
import { View } from 'react-native';

/** Read failures must never look like a new guest account or erase a saved profile. */
export function ProfileRestoreNotice({ restorationOnly = false }: { restorationOnly?: boolean }) {
  const demo = useAccount();
  if (!demo.error || (demo.ready && (demo.mode === 'demo' || restorationOnly))) return null;
  return (
    <View testID="profile-restore-error" style={{ gap: 12, marginTop: 16 }}>
      <Body style={{ color: '#FFB0AB' }}>{demo.error}</Body>
      <Button
        title={
          demo.busy
            ? 'Восстанавливаем…'
            : demo.ready
              ? 'Повторить соединение'
              : 'Повторить чтение профиля'
        }
        testID="profile-restore-retry"
        secondary
        disabled={demo.busy}
        onPress={() => void demo.retryRestore()}
      />
    </View>
  );
}
