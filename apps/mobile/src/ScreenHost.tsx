import { useRouter } from 'expo-router';
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
    <View style={{ flex: 1, backgroundColor: '#04143A' }}>
      <MobileScreen
        screenId={id}
        model={model}
        navigate={navigate}
        goBack={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/menu'))}
        preview={preview}
      />
      <Pressable
        testID="open-design-review"
        accessibilityRole="button"
        accessibilityLabel="Открыть каталог всех экранов дизайна"
        onPress={() => router.push('/review')}
        style={{
          minHeight: 44,
          paddingHorizontal: 16,
          paddingVertical: 10,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#0A2050',
        }}
      >
        <Text style={{ color: '#C0CDE6', fontFamily: 'Manrope_600SemiBold', fontSize: 12 }}>
          {preview
            ? 'Пример дизайна · операции не выполняются'
            : model.testFlow.available
              ? 'Тестовая версия · связана с тестовой кухней'
              : 'Тестовая версия · заказ пока недоступен'}{' '}
          ↗
        </Text>
      </Pressable>
    </View>
  );
}
