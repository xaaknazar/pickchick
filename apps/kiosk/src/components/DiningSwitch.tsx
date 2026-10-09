import { useState } from 'react';
import { Animated, Pressable, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { copy, type Locale } from '../i18n';
import type { KioskMode } from '../model';
import { colors, fonts, useMetrics } from '../theme';
import { fixedText } from './Body';
import { Icon } from './Icon';
import { useTimingTo } from './motion';
const modes: KioskMode[] = ['dine_in', 'takeaway'];
/**
 * v3 menu-header dining switch (prototype `#eat`): two segments "В зале / С собой"
 * on a dark glass track (240x52, radius 26, white .2 inset line); the #FF6900 pill
 * (44 high, radius 22) glides to the chosen side (380 ms --spring). Both sides
 * share the wider label's width (at least half the drawn track) so only the
 * pill's position moves. The choice shows at once; `onChange` saves it.
 */
export function DiningSwitch({
  mode,
  locale,
  disabled = false,
  onChange,
  testID = 'kiosk-header-mode',
}: {
  mode: KioskMode | null;
  locale: Locale;
  disabled?: boolean;
  /** Saves the choice; resolving `false` puts the pill back. */
  onChange: (mode: KioskMode) => unknown;
  testID?: string;
}) {
  const { v, px } = useMetrics();
  const t = copy(locale);
  const [chosen, setChosen] = useState(mode);
  const [seen, setSeen] = useState(mode);
  if (seen !== mode) {
    setSeen(mode);
    setChosen(mode);
  }
  const [natural, setNatural] = useState<[number, number]>([0, 0]);
  // Drawn track 240 = 4 + 2 x 115 + 2 + 4; longer (Kazakh) labels widen both halves.
  const half = v(115);
  const span = natural[0] && natural[1] ? Math.max(natural[0], natural[1], half) : 0;
  const label = (m: KioskMode) => (m === 'dine_in' ? t.hereChip : t.togo);
  return (
    <View
      testID={testID}
      accessibilityRole="radiogroup"
      accessibilityLabel={chosen ? label(chosen) : undefined}
      style={{
        flexDirection: 'row',
        gap: v(2),
        padding: v(4),
        borderRadius: v(26),
        backgroundColor: 'rgba(4,20,58,.35)',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,.2)',
      }}
    >
      {span && chosen ? <Pill span={span} offset={modes.indexOf(chosen) * (span + v(2))} /> : null}
      {modes.map((m, index) => (
        <Pressable
          key={m}
          testID={testID + '-' + m}
          accessibilityRole="radio"
          accessibilityLabel={label(m)}
          accessibilityState={{ checked: chosen === m, disabled }}
          aria-checked={chosen === m}
          disabled={disabled}
          onLayout={(e) => {
            const measured = e.nativeEvent.layout.width;
            setNatural((current) => {
              if ((current[index] ?? 0) >= measured) return current;
              const next: [number, number] = [current[0], current[1]];
              next[index] = measured;
              return next;
            });
          }}
          onPress={() => {
            if (chosen === m) return;
            setChosen(m);
            const saved = onChange(m);
            if (saved instanceof Promise)
              void saved.then(
                (ok) => {
                  if (ok === false) setChosen(mode);
                },
                () => setChosen(mode),
              );
          }}
          style={{
            minWidth: span || half,
            height: v(44),
            paddingHorizontal: v(12),
            borderRadius: v(22),
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: v(6),
          }}
        >
          {m === 'dine_in' ? (
            // Design 🍴: upright fork and knife (Ionicons only has them crossed).
            <MaterialCommunityIcons
              name="silverware-fork-knife"
              size={px(20)}
              color={colors.white}
              accessible={false}
            />
          ) : (
            <Icon name="bag-handle-outline" size="small" tone="inverse" />
          )}
          <Text
            {...fixedText}
            numberOfLines={1}
            style={{ fontFamily: fonts.heavy, fontSize: v(14), color: colors.white }}
          >
            {label(m).toUpperCase()}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
/** The orange pill; mounted once both sides are measured so it never slides in. */
function Pill({ span, offset }: { span: number; offset: number }) {
  const { v } = useMetrics();
  const x = useTimingTo(offset, 380, 'spring');
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: v(4),
        top: v(4),
        bottom: v(4),
        width: span,
        borderRadius: v(22),
        backgroundColor: colors.orange,
        transform: [{ translateX: x }],
      }}
    />
  );
}
