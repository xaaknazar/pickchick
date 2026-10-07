import { Pressable } from 'react-native';
import { colors, useMetrics } from '../theme';
import { Icon, type IconName } from './Icon';
export function IconButton({
  name,
  label,
  onPress,
  testID,
  tone = 'neutral',
  size = 'regular',
  disabled = false,
}: {
  name: IconName;
  label: string;
  onPress: () => void;
  testID?: string;
  tone?: 'neutral' | 'inverse' | 'accent';
  size?: 'regular' | 'large';
  disabled?: boolean;
}) {
  const { px } = useMetrics();
  const dim = Math.max(48, px(size === 'large' ? 72 : 60));
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        width: dim,
        height: dim,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor:
          tone === 'accent'
            ? colors.orange
            : tone === 'inverse'
              ? 'rgba(255,255,255,.14)'
              : colors.light,
        opacity: disabled ? 0.35 : pressed ? 0.65 : 1,
      })}
    >
      <Icon
        name={name}
        tone={tone === 'inverse' ? 'inverse' : tone === 'accent' ? 'default' : 'brand'}
      />
    </Pressable>
  );
}
