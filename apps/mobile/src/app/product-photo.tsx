import { useLocalSearchParams, useRouter } from 'expo-router';
import { View, Text } from 'react-native';
import { useMobile } from '../store';
import { PhotoProduct } from '../screens/PhotoProduct';
import { hasPhotoPilot } from '../product-photo-selection';
import { Button } from '../components/UI';
export default function ProductPhotoRoute() {
  const params = useLocalSearchParams<{ product?: string; preview?: string }>();
  const preview = params.preview === '1';
  const model = useMobile(preview);
  const router = useRouter();
  const product = model.products.find((p) => p.id === params.product && hasPhotoPilot(p));
  const back = () => {
    if (router.canGoBack()) router.back();
    else if (preview)
      router.replace({ pathname: '/screen/[id]', params: { id: 'M06', preview: '1' } });
    else router.replace('/(tabs)/menu');
  };
  if (!product)
    return (
      <View
        style={{
          flex: 1,
          justifyContent: 'center',
          padding: 24,
          gap: 20,
          backgroundColor: '#04143A',
        }}
      >
        <Text style={{ color: 'white', fontSize: 20 }}>Позиция пока недоступна</Text>
        <Button title="Вернуться в меню" onPress={back} />
      </View>
    );
  return (
    <PhotoProduct
      key={`${product.source}:${product.catalogVersion}:${product.id}`}
      product={product}
      model={model}
      screenId="M07"
      preview={preview}
      goBack={back}
      navigate={(id) =>
        router.push({
          pathname: '/screen/[id]',
          params: { id, ...(preview ? { preview: '1' } : {}) },
        })
      }
    />
  );
}
