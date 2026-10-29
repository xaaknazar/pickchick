import { useLocalSearchParams } from 'expo-router';
import { ScreenHost } from '../ScreenHost';
import { designPreview } from '../store-build';
export default function CartRoute() {
  const { preview } = useLocalSearchParams();
  return <ScreenHost id="M09" preview={designPreview(preview)} />;
}
