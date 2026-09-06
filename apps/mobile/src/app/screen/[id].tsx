import { useLocalSearchParams } from 'expo-router';
import { ScreenHost } from '../../ScreenHost';
import type { ScreenId } from '../../model';
export default function ScreenRoute() {
  const params = useLocalSearchParams<{ id: string; preview?: string }>();
  const valid = typeof params.id === 'string' && /^M(0[1-9]|[12]\d|3[0-5])$/.test(params.id);
  return (
    <ScreenHost id={valid ? (params.id as ScreenId) : 'M06'} preview={params.preview === '1'} />
  );
}
