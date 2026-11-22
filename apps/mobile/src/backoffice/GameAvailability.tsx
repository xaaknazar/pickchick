import { t, useLocale } from '../i18n';
import type { ReactNode } from 'react';
import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useMobile } from '../store';
import { Body, Button, Heading } from '../components/UI';
import { usePublishedContent } from './usePublishedContent';
import type { GameTemplate } from './content-model';
export function GameAvailability({
  template,
  children,
}: {
  template: GameTemplate;
  children: ReactNode;
}) {
  useLocale();
  const model = useMobile(),
    router = useRouter(),
    config = usePublishedContent(model.branch?.id);
  if (config.gameEnabled(template)) return children;
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#0A1020' }}>
      <View
        testID="game-unavailable"
        style={{ flex: 1, justifyContent: 'center', padding: 24, gap: 20 }}
      >
        <Heading>{t('Игра сейчас недоступна')}</Heading>
        <Body muted>{t('Выбери другую игру в «Играх».')}</Body>
        <Button title={t('К играм')} onPress={() => router.replace('/(tabs)/events')} />
      </View>
    </SafeAreaView>
  );
}
