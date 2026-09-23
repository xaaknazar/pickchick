import { useRouter } from 'expo-router';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import screens from '../../../../design/prototype/screens.json';

export default function Review() {
  const router = useRouter();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#04143A' }}>
      <ScrollView contentContainerStyle={{ padding: 20, gap: 12 }}>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.back()}
          style={{ minHeight: 48, justifyContent: 'center' }}
        >
          <Text style={{ color: '#93BCFF', fontSize: 16 }}>← Назад</Text>
        </Pressable>
        <Text style={{ color: '#F2F6FF', fontFamily: 'Jost_700Bold', fontSize: 32 }}>
          Все экраны PickChick
        </Text>
        <Text
          style={{
            color: '#C0CDE6',
            fontFamily: 'Manrope_400Regular',
            fontSize: 16,
            lineHeight: 24,
          }}
        >
          33 страницы для проверки дизайна. Заказы, платежи и Чики здесь - примеры дизайна. Действия
          не отправляются в ресторан или банк.
        </Text>
        {screens
          .filter((screen) => screen.surface === 'mobile' && !['M27', 'M28'].includes(screen.id))
          .map((screen) => (
            <Pressable
              key={screen.id}
              testID={`review-${screen.id}`}
              accessibilityRole="button"
              onPress={() =>
                router.push({ pathname: '/screen/[id]', params: { id: screen.id, preview: '1' } })
              }
              style={{ borderRadius: 16, backgroundColor: '#0A2050', padding: 16, minHeight: 68 }}
            >
              <View style={{ flexDirection: 'row', gap: 16, alignItems: 'center' }}>
                <Text style={{ color: '#93BCFF', fontSize: 14 }}>{screen.id}</Text>
                <Text
                  style={{
                    color: '#F2F6FF',
                    fontFamily: 'Manrope_600SemiBold',
                    flex: 1,
                    fontSize: 16,
                  }}
                >
                  {screen.title}
                </Text>
                <Text style={{ color: '#93BCFF', fontSize: 20 }}>›</Text>
              </View>
            </Pressable>
          ))}
      </ScrollView>
    </SafeAreaView>
  );
}
