import { ScreenHost } from '../../ScreenHost';
import { useLocalSearchParams } from 'expo-router';
export default function Menu() {
  const { preview } = useLocalSearchParams();
  return <ScreenHost id="M06" preview={preview === '1'} />;
}
