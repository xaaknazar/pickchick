import { ScreenTransition } from './components/Motion';
import { GameAvailability } from './backoffice/GameAvailability';
import { useLocalSearchParams, useRouter, useSegments } from 'expo-router';
import { accountDestination } from './account-access';
import { Pressable, Text } from 'react-native';
import type { ScreenId } from './model';
import { useMobile } from './store';
import { CartShortcut } from './components/CartShortcut';
import { MobileScreen } from './screens/MobileScreen';

const tabRoutes = {
  M06: '/(tabs)/menu',
  M26: '/(tabs)/events',
  M19: '/(tabs)/orders',
  M30: '/(tabs)/profile',
} as const;
export function ScreenHost({ id, preview = false }: { id: ScreenId; preview?: boolean }) {
  const router = useRouter();
  const segments = useSegments();
  const params = useLocalSearchParams();
  const returnTo = accountDestination(params.returnTo);
  const model = useMobile(preview);
  const activeTab =
    segments[0] === '(tabs)' &&
    id in tabRoutes &&
    tabRoutes[id as keyof typeof tabRoutes] === `/${segments.join('/')}`;
  const navigate = (next: ScreenId) => {
    if (!preview && returnTo && id === 'M04' && (next === 'M06' || next === 'M30')) {
      if (returnTo === 'pick-man') router.replace('/games/pick-man');
      else if (returnTo === 'pick-blocks') router.replace('/games/pick-blocks');
      else router.replace({ pathname: '/screen/[id]', params: { id: returnTo } });
      return;
    }
    if (!preview && next in tabRoutes) router.navigate(tabRoutes[next as keyof typeof tabRoutes]);
    else
      router.push({
        pathname: '/screen/[id]',
        params: {
          id: next,
          ...(preview ? { preview: '1' } : {}),
          ...(!preview && returnTo && ['M02', 'M03', 'M04'].includes(next) ? { returnTo } : {}),
        },
      });
  };
  const screen = (
    <MobileScreen
      screenId={id}
      model={model}
      navigate={navigate}
      goBack={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/menu'))}
      preview={preview}
      inTabLayout={segments[0] === '(tabs)'}
      openReview={() => router.push('/review')}
    />
  );
  return (
    <ScreenTransition style={{ flex: 1, minHeight: 0, backgroundColor: '#04143A' }}>
      {!preview && (id === 'M27' || id === 'M28') ? (
        <GameAvailability template="pick-run">{screen}</GameAvailability>
      ) : (
        screen
      )}
      {activeTab ? <CartShortcut model={model} onPress={() => navigate('M09')} /> : null}
      {preview ? (
        <Pressable
          testID="open-design-review"
          accessibilityRole="button"
          accessibilityLabel="Открыть каталог всех экранов дизайна"
          onPress={() => router.push('/review')}
          style={{
            minHeight: 44,
            flexShrink: 0,
            paddingHorizontal: 16,
            paddingVertical: 10,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: '#0A2050',
          }}
        >
          <Text style={{ color: '#C0CDE6', fontFamily: 'Manrope_600SemiBold', fontSize: 12 }}>
            Пример дизайна · операции не выполняются ↗
          </Text>
        </Pressable>
      ) : null}
    </ScreenTransition>
  );
}
