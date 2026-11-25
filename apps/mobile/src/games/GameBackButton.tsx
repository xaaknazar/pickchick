import { Pressable, StyleSheet } from 'react-native';
import { Icon } from '../components/UI';

/**
 * The one «назад» of every game (owner 25.11.2026): the same button in the same corner, and one
 * tap always leaves the game at once. It never opens a pause menu or closes a panel first.
 * The navy plate with a white chevron reads on every game's backdrop, light or dark.
 */
export function GameBackButton({
  label,
  onPress,
  testID,
}: {
  label: string;
  onPress(): void;
  testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [s.button, pressed && s.pressed]}
    >
      <Icon name="chevron-back" color="#FFFFFF" size={24} />
    </Pressable>
  );
}

const s = StyleSheet.create({
  button: {
    width: 48,
    height: 48,
    borderRadius: 16,
    backgroundColor: '#10213DE6',
    borderWidth: 1,
    borderColor: '#FFFFFF24',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { backgroundColor: '#213F66', transform: [{ scale: 0.96 }] },
});
