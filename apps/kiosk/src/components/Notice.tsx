import { View } from 'react-native';
import { useMetrics } from '../theme';
import { Body, Heading, Wrapper } from './UI';
export function Notice({
  title,
  body,
  tone = 'info',
  testID,
}: {
  title?: string;
  body: string;
  tone?: 'info' | 'error';
  testID?: string;
}) {
  const { px } = useMetrics();
  return (
    <View
      testID={testID}
      accessibilityRole={tone === 'error' ? 'alert' : undefined}
      style={{
        backgroundColor: tone === 'error' ? '#FFF1EB' : '#ECF2FC',
        borderRadius: 16,
        padding: px(24),
      }}
    >
      <Wrapper gap={8}>
        {title ? (
          <Heading size="card" tone={tone === 'error' ? 'danger' : 'brand'}>
            {title}
          </Heading>
        ) : null}
        <Body tone={tone === 'error' ? 'danger' : 'brand'}>{body}</Body>
      </Wrapper>
    </View>
  );
}
