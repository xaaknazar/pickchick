import { View } from 'react-native';
import { colors, useMetrics } from '../theme';
import { Body, Heading, Icon, Wrapper } from './UI';
/**
 * v3 notice: a white card that reads on blue and on white sheets alike. The
 * error variant uses deep orange (title, icon, hairline; the body too when it
 * stands alone) and is announced as an alert.
 */
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
  const { v } = useMetrics();
  const error = tone === 'error';
  return (
    <View
      testID={testID}
      accessibilityRole={error ? 'alert' : undefined}
      style={{
        backgroundColor: colors.white,
        borderRadius: v(22),
        borderWidth: 1,
        borderColor: error ? 'rgba(226,92,0,.32)' : colors.border,
        paddingVertical: v(18),
        paddingHorizontal: v(20),
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: v(14),
        shadowColor: '#020A28',
        shadowOpacity: 0.16,
        shadowRadius: 18,
        shadowOffset: { width: 0, height: 8 },
        elevation: 5,
      }}
    >
      <Icon
        name={error ? 'alert-circle-outline' : 'information-circle-outline'}
        tone={error ? 'deep' : 'brand'}
      />
      <Wrapper flex={1} gap={6}>
        {title ? (
          <Heading size="card" tone={error ? 'deep' : 'navy'}>
            {title}
          </Heading>
        ) : null}
        <Body tone={error && !title ? 'deep' : 'default'} variant={error ? 'label' : 'body'}>
          {body}
        </Body>
      </Wrapper>
    </View>
  );
}
