import { useState } from 'react';
import { Animated, Pressable, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { copy, type Locale } from '../i18n';
import type { KioskMode } from '../model';
import { colors, fonts, redesign, useMetrics } from '../theme';
import { fixedText } from './Body';
import { GlassPanel } from './GlassPanel';
import { Icon } from './Icon';
import { useTimingTo } from './motion';
import { ownerOrange } from './ownerOrange';
const modes: KioskMode[] = ['dine_in', 'takeaway'];
/**
 * Design `#eat` "В зале" glyph: the prototype's inline upright fork and knife
 * (24 grid, stroke 2.2), drawn as SVG so no extra icon font enters the bundle.
 */
const utensils =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF"' +
      ' stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/>' +
      '<path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/></svg>',
  );
/** Inner padding of the 64 pt glass track around its 52 pt options. */
const inset = 6;
/**
 * Menu-header dining switch (kiosk redesign 2026-10-13, README section 3): "В ЗАЛЕ / С СОБОЙ"
 * on the owner-approved glass, a 64 pt track with 52 pt options; the design-orange pill glides
 * to the chosen side (380 ms spring, instant under reduced motion). Both sides share the wider
 * label's width (at least 150 pt) so only the pill moves, and longer Kazakh or English labels
 * widen both halves instead of wrapping. The choice shows at once; `onChange` saves it.
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
  const { px } = useMetrics();
  const t = copy(locale);
  const [chosen, setChosen] = useState(mode);
  const [seen, setSeen] = useState(mode);
  if (seen !== mode) {
    setSeen(mode);
    setChosen(mode);
  }
  const [natural, setNatural] = useState<[number, number]>([0, 0]);
  const half = px(150);
  const gap = px(2);
  const span = natural[0] && natural[1] ? Math.max(natural[0], natural[1], half) : 0;
  const label = (m: KioskMode) => (m === 'dine_in' ? t.hereChip : t.togo);
  return (
    <View style={{ flexShrink: 0 }}>
      <GlassPanel>
        <View
          testID={testID}
          {...ownerOrange}
          accessibilityRole="radiogroup"
          accessibilityLabel={chosen ? label(chosen) : undefined}
          style={{ flexDirection: 'row', gap, padding: px(inset) }}
        >
          {span && chosen ? (
            <Pill span={span} offset={modes.indexOf(chosen) * (span + gap)} />
          ) : null}
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
                height: Math.max(44, px(52)),
                paddingHorizontal: px(18),
                borderRadius: 999,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: px(8),
              }}
            >
              {m === 'dine_in' ? (
                <Image
                  source={{ uri: utensils }}
                  contentFit="contain"
                  style={{ width: px(20), height: px(20) }}
                  accessible={false}
                  accessibilityLabel=""
                />
              ) : (
                <Icon name="bag-handle-outline" size="small" tone="inverse" />
              )}
              <Text
                {...fixedText}
                numberOfLines={1}
                style={{ fontFamily: fonts.heavy, fontSize: px(18), color: colors.white }}
              >
                {label(m).toUpperCase()}
              </Text>
            </Pressable>
          ))}
        </View>
      </GlassPanel>
    </View>
  );
}
/** The orange pill; mounted once both sides are measured so it never slides in. */
function Pill({ span, offset }: { span: number; offset: number }) {
  const { px } = useMetrics();
  const x = useTimingTo(offset, 380, 'spring');
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: px(inset),
        top: px(inset),
        bottom: px(inset),
        width: span,
        borderRadius: 999,
        // Active control: the design orange (owner decision 2026-10-10, redesign token).
        backgroundColor: redesign.cta,
        transform: [{ translateX: x }],
      }}
    />
  );
}
