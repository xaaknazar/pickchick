import { ActivityIndicator } from 'react-native';
import { colors } from '../theme';
import { Body, Button, Heading, ScreenSurface, Wrapper } from './UI';
export function BootState({
  title,
  message,
  busy = false,
  loading = true,
  onRetry,
  retryLabel = 'Повторить',
}: {
  title?: string;
  message?: string | null;
  busy?: boolean;
  loading?: boolean;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <ScreenSurface>
      <Wrapper flex={1} padding={40} gap={24} align="center" justify="center">
        {loading ? <ActivityIndicator size="large" color={colors.blue} /> : null}
        {title ? (
          <Heading size="section" align="center">
            {title}
          </Heading>
        ) : null}
        {message ? <Body align="center">{message}</Body> : null}
        {onRetry ? <Button label={retryLabel} onPress={onRetry} busy={busy} /> : null}
      </Wrapper>
    </ScreenSurface>
  );
}
