import { useRouter, useSegments } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import type { ScreenId } from './model';
import { useMobile } from './store';
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
  const model = useMobile(preview);
  const navigate = (next: ScreenId) => {
    if (!preview && next in tabRoutes) router.navigate(tabRoutes[next as keyof typeof tabRoutes]);
    else
      router.push({
        pathname: '/screen/[id]',
        params: { id: next, ...(preview ? { preview: '1' } : {}) },
      });
  };
  return (
    <View style={{ flex: 1, minHeight: 0, backgroundColor: '#04143A' }}>
      <MobileScreen
        screenId={id}
        model={model}
        navigate={navigate}
        goBack={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/menu'))}
        preview={preview}
        inTabLayout={segments[0] === '(tabs)'}
        openReview={() => router.push('/review')}
      />
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
    </View>
  );
}
