import { useLocalSearchParams } from 'expo-router';
import { ScreenHost } from '../ScreenHost';
import { designPreview } from '../store-build';
export default function OrderStatusRoute() {
  const { preview, id } = useLocalSearchParams();
  return (
    <ScreenHost
      id={id === 'M18' ? 'M18' : id === 'M17' ? 'M17' : 'M20'}
      preview={designPreview(preview)}
    />
  );
}
