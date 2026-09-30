import type { ReactNode } from 'react';
import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useMobile } from '../store';
import { Body, Button, Heading } from '../components/UI';
import { usePublishedContent } from './usePublishedContent';
export function GameAvailability({
  template,
  children,
}: {
  template: 'pick-run' | 'pick-man' | 'pick-blocks';
  children: ReactNode;
}) {
  const model = useMobile(),
    router = useRouter(),
    config = usePublishedContent(model.branch?.id);
  if (config.gameEnabled(template)) return children;
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#04143A' }}>
      <View
        testID="game-unavailable"
        style={{ flex: 1, justifyContent: 'center', padding: 24, gap: 20 }}
      >
        <Heading>Игра пока недоступна</Heading>
        <Body muted>Загляни позже - здесь появится новая игра.</Body>
        <Button title="К событиям" onPress={() => router.replace('/(tabs)/events')} />
      </View>
    </SafeAreaView>
  );
}
