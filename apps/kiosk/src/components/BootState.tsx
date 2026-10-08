import { ActivityIndicator } from 'react-native';
import { colors } from '../theme';
import { Body, Button, Heading, Logo, ScreenSurface, Wrapper } from './UI';
/** v3 boot and blocking-error state: the blue surface, logo, white spinner and copy. */
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
    <ScreenSurface tone="brand">
      <Wrapper flex={1} padding={48} gap={28} align="center" justify="center">
        <Logo size="large" />
        {loading ? (
          <ActivityIndicator
            accessibilityLabel={title ?? 'Загрузка'}
            size="large"
            color={colors.white}
          />
        ) : null}
        {title ? (
          <Wrapper maxWidth={760}>
            <Heading size="section" tone="inverse" align="center">
              {title}
            </Heading>
          </Wrapper>
        ) : null}
        {message ? (
          <Wrapper maxWidth={760}>
            <Body tone="onBlue" align="center">
              {message}
            </Body>
          </Wrapper>
        ) : null}
        {onRetry ? <Button label={retryLabel} onPress={onRetry} busy={busy} /> : null}
      </Wrapper>
    </ScreenSurface>
  );
}
