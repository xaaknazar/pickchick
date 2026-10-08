import { Pressable } from 'react-native';
import { colors, useMetrics } from '../theme';
import { Icon, type IconName } from './Icon';
/** Round v3 control: `inverse` glass on blue, `light` white disc, `accent` orange. */
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
  tone?: 'neutral' | 'inverse' | 'accent' | 'light';
  size?: 'regular' | 'large';
  disabled?: boolean;
}) {
  const { v } = useMetrics();
  const dim = Math.max(48, v(size === 'large' ? 72 : 60));
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
        borderRadius: dim / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor:
          tone === 'accent'
            ? colors.orange
            : tone === 'inverse'
              ? colors.glass
              : tone === 'light'
                ? colors.white
                : colors.soft,
        shadowColor: '#04143A',
        shadowOpacity: tone === 'light' ? 0.14 : 0,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 6 },
        opacity: disabled ? 0.35 : 1,
        transform: [{ scale: pressed ? 0.92 : 1 }],
      })}
    >
      <Icon name={name} tone={tone === 'inverse' || tone === 'accent' ? 'inverse' : 'navy'} />
    </Pressable>
  );
}
