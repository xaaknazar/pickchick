import { useState } from 'react';
import { Linking, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { BUILD_CONFIG, supportLink } from '../build-config';
import { Button, Caption } from './UI';

/**
 * The build's support contact (EXPO_PUBLIC_SUPPORT_URL), or an honest fallback that sends the
 * customer to the restaurant staff when the build has none. Audit 0.2 / 2.0 / 2.7.
 */
export function SupportContact({
  fallback = 'Если вопрос не решится, обратитесь к сотруднику ресторана и назовите сумму и время заказа.',
  buttonStyle,
  textStyle,
}: {
  /** Text when the build has no contact; null renders nothing. */
  fallback?: string | null;
  buttonStyle?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
}) {
  const link = supportLink(BUILD_CONFIG.supportUrl);
  const [failed, setFailed] = useState(false);
  if (!link && !fallback) return null;
  if (!link)
    return (
      <Caption testID="support-contact-fallback" style={textStyle}>
        {fallback}
      </Caption>
    );
  return (
    <>
      <Button
        secondary
        title={link.label}
        testID="support-contact"
        style={buttonStyle}
        onPress={() => {
          setFailed(false);
          void Linking.openURL(link.url).catch(() => setFailed(true));
        }}
      />
      {failed ? (
        <Caption style={textStyle}>
          Не удалось открыть контакт: {link.url.replace(/^(tel|mailto):/, '')}
        </Caption>
      ) : null}
    </>
  );
}
