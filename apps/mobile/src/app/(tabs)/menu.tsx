import { ScreenHost } from '../../ScreenHost';
import { designPreview } from '../../store-build';
import { useLocalSearchParams } from 'expo-router';
export default function Menu() {
  const { preview } = useLocalSearchParams();
  return <ScreenHost id="M06" preview={designPreview(preview)} />;
}
