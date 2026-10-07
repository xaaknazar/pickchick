import { TextInput, View } from 'react-native';
import { colors, fonts, useMetrics } from '../theme';
import { Body } from './Body';
export function DeviceField({
  name,
  label,
  value,
  onChange,
  busy,
}: {
  name: 'id' | 'key';
  label: string;
  value: string;
  onChange: (v: string) => void;
  busy: boolean;
}) {
  const { px } = useMetrics();
  return (
    <View style={{ gap: 8 }}>
      <Body variant="label">{label}</Body>
      <TextInput
        testID={'kiosk-enrollment-' + name}
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        editable={!busy}
        secureTextEntry={name === 'key'}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        textContentType="none"
        maxLength={name === 'key' ? 128 : 64}
        style={{
          minHeight: 56,
          padding: px(18),
          borderWidth: 2,
          borderColor: colors.border,
          borderRadius: 16,
          fontFamily: fonts.body,
          fontSize: 20,
          color: colors.ink,
          backgroundColor: colors.white,
        }}
      />
    </View>
  );
}
