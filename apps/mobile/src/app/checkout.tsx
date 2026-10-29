import { useLocalSearchParams } from 'expo-router';
import { ScreenHost } from '../ScreenHost';
import { designPreview } from '../store-build';
export default function CheckoutRoute() {
  const { preview } = useLocalSearchParams();
  return <ScreenHost id="M12" preview={designPreview(preview)} />;
}
