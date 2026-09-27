import { OrderSheet } from './components/OrderSheet';
import { useCallback, useState } from 'react';
import { ScreenTransition } from './components/Motion';
import { Redirect, useLocalSearchParams, useRouter, useSegments } from 'expo-router';
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
  const [cartHeight, setCartHeight] = useState(100);
  const router = useRouter();
  const segments = useSegments();
  const params = useLocalSearchParams();
  const returnTo = accountDestination(params.returnTo);
  const model = useMobile(preview);
  const activeTab =
    segments[0] === '(tabs)' &&
    id in tabRoutes &&
    tabRoutes[id as keyof typeof tabRoutes] === `/${segments.join('/')}`;
  const statusSheet = ['M17', 'M18', 'M20'].includes(id);
  const inSheet = id === 'M09' || id === 'M12' || statusSheet;
  const back = useCallback(
    () => (router.canGoBack() ? router.back() : router.replace('/(tabs)/menu')),
    [router],
  );
  const navigate = (next: ScreenId) => {
    if (['M17', 'M18', 'M20'].includes(next)) {
      if (id === 'M12') router.dismissAll();
      router.navigate({
        pathname: '/order-status',
        params: { id: next, ...(preview ? { preview: '1' } : {}) },
      });
      return;
    }
    if (next === 'M09' || next === 'M12') {
      if (id === 'M12' && next === 'M09' && router.canGoBack()) {
        router.back();
        return;
      }
      router.push({
        pathname: next === 'M09' ? '/cart' : '/checkout',
        params: preview ? { preview: '1' } : {},
      });
      return;
    }
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
  // Temporarily removed from the customer arcade by the owner. Old links return to events.
  if (id === 'M27' || id === 'M28') return <Redirect href="/(tabs)/events" />;
  const screen = (goBack = back) => (
    <MobileScreen
      screenId={id}
      model={model}
      navigate={navigate}
      goBack={goBack}
      inSheet={inSheet}
      preview={preview}
      cartBottomInset={activeTab && model.cart.length ? cartHeight : 0}
      inTabLayout={segments[0] === '(tabs)'}
      openReview={() => router.push('/review')}
    />
  );
  if (inSheet)
    return (
      <OrderSheet
        raised={statusSheet}
        productHeight={id === 'M09' || id === 'M12'}
        name={statusSheet ? 'Статус заказа' : id === 'M09' ? 'Корзина' : 'Оформление'}
        onClose={back}
      >
        {(close) => screen(close)}
      </OrderSheet>
    );
  return (
    <ScreenTransition style={{ flex: 1, minHeight: 0, backgroundColor: '#04143A' }}>
      {screen()}
      {activeTab ? (
        <CartShortcut
          model={model}
          onPress={() => navigate('M09')}
          floating
          onHeightChange={setCartHeight}
        />
      ) : null}
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
