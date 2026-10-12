import { Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { colors, fonts, redesign, useMetrics } from '../theme';
import { fixedText } from './Body';
/**
 * Redesign 2026-10-13 badge (README "Общие токены"): `hit` is the red 135deg gradient
 * (#FF3B1F -> #D7141A) turned -2deg, `new` the brand blue #0047BB; white Montserrat 800 at
 * 14 pt with .1em tracking. `tag` is the hit tile's label (8 pt corners), `pill` the round card
 * badge. Its position belongs to the owning card.
 */
export function Badge({
  label,
  tone = 'hit',
  shape = 'pill',
}: {
  label: string;
  tone?: 'hit' | 'new';
  shape?: 'pill' | 'tag';
}) {
  const { px } = useMetrics();
  const tag = shape === 'tag';
  const size = px(14);
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        height: px(tag ? 34 : 30),
        paddingHorizontal: px(tag ? 14 : 12),
        borderRadius: tag ? px(8) : 999,
        overflow: 'hidden',
        justifyContent: 'center',
        backgroundColor: tone === 'hit' ? redesign.hit[1] : redesign.newBadge,
        transform: tone === 'hit' ? [{ rotate: '-2deg' }] : [],
      }}
    >
      {tone === 'hit' ? (
        <LinearGradient
          colors={[redesign.hit[0], redesign.hit[1]]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }}
          pointerEvents="none"
        />
      ) : null}
      <Text
        {...fixedText}
        numberOfLines={1}
        style={{
          fontFamily: fonts.heavy,
          fontSize: size,
          letterSpacing: size * 0.1,
          color: colors.white,
        }}
      >
        {label}
      </Text>
    </View>
  );
}
