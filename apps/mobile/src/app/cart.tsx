import { useLocalSearchParams } from 'expo-router';
import { ScreenHost } from '../ScreenHost';
export default function CartRoute() {
  const { preview } = useLocalSearchParams();
  return <ScreenHost id="M09" preview={preview === '1'} />;
}
