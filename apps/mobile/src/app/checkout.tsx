import { useLocalSearchParams } from 'expo-router';
import { ScreenHost } from '../ScreenHost';
export default function CheckoutRoute() {
  const { preview } = useLocalSearchParams();
  return <ScreenHost id="M12" preview={preview === '1'} />;
}
