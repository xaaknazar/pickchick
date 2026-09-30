import { Redirect, useLocalSearchParams } from 'expo-router';
import { ScreenHost } from '../../ScreenHost';
import type { ScreenId } from '../../model';
export default function ScreenRoute() {
  const params = useLocalSearchParams<{ id: string; preview?: string }>();
  const valid = typeof params.id === 'string' && /^M(0[1-9]|[12]\d|3[0-5])$/.test(params.id);
  if (params.id === 'M09' || params.id === 'M12')
    return (
      <Redirect
        href={{
          pathname: params.id === 'M09' ? '/cart' : '/checkout',
          params: { ...(params.preview === '1' ? { preview: '1' } : {}) },
        }}
      />
    );
  if (['M17', 'M18', 'M20'].includes(params.id))
    return (
      <Redirect
        href={{
          pathname: '/order-status',
          params: { id: params.id, ...(params.preview === '1' ? { preview: '1' } : {}) },
        }}
      />
    );
  return (
    <ScreenHost id={valid ? (params.id as ScreenId) : 'M06'} preview={params.preview === '1'} />
  );
}
