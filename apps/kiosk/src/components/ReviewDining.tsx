import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { copy, type Locale } from '../i18n';
import type { KioskMode } from '../model';
import { colors, fonts, redesign, useMetrics } from '../theme';
import { fixedText } from './Body';
import { Heading } from './Heading';
import { Icon } from './Icon';
import { ownerOrange } from './ownerOrange';
import { utensils } from './DiningSwitch';
const modes: KioskMode[] = ['dine_in', 'takeaway'];
/** The fork-and-knife glyph drawn in navy for the unselected tile. */
const utensilsNavy = utensils.replace(
  encodeURIComponent('#FFFFFF'),
  encodeURIComponent(colors.navy),
);
/**
 * Owner 23.11.2026: the payment page must clearly show «В зале» or «С собой», and the guest
 * must be able to change it right there. Two large tiles under «Где будете есть?»: the chosen
 * one is filled with the design orange and carries a check, the other stays white. A tap saves
 * the new mode in place (the guest stays on the payment page); a refused save puts it back.
 */
export function ReviewDining({
  mode,
  locale,
  disabled = false,
  onChange,
}: {
  mode: KioskMode | null;
  locale: Locale;
  disabled?: boolean;
  onChange: (mode: KioskMode) => unknown;
}) {
  const { v } = useMetrics();
  const t = copy(locale);
  const [chosen, setChosen] = useState(mode);
  const [seen, setSeen] = useState(mode);
  if (seen !== mode) {
    setSeen(mode);
    setChosen(mode);
  }
  const label = (m: KioskMode) => (m === 'dine_in' ? t.hereChip : t.togo);
  return (
    <View style={{ gap: v(14) }}>
      <Heading size="section" tone="inverse">
        {t.reviewWhere}
      </Heading>
      <View
        testID="kiosk-review-mode"
        accessibilityRole="radiogroup"
        accessibilityLabel={t.reviewWhere}
        style={{ flexDirection: 'row', gap: v(14) }}
      >
        {modes.map((m) => {
          const on = chosen === m;
          return (
            <Pressable
              key={m}
              testID={'kiosk-review-mode-' + m}
              {...(on ? ownerOrange : {})}
              accessibilityRole="radio"
              accessibilityLabel={label(m)}
              accessibilityState={{ checked: on, disabled }}
              aria-checked={on}
              disabled={disabled}
              onPress={() => {
                if (on) return;
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
              style={({ pressed }) => ({
                flex: 1,
                minHeight: Math.max(88, v(104)),
                borderRadius: v(26),
                paddingHorizontal: v(22),
                flexDirection: 'row',
                alignItems: 'center',
                gap: v(16),
                backgroundColor: on ? redesign.cta : colors.white,
                borderWidth: on ? 0 : 2,
                borderColor: 'rgba(4,20,58,0.08)',
                shadowColor: '#020A28',
                shadowOpacity: on ? 0.28 : 0.14,
                shadowRadius: on ? 20 : 12,
                shadowOffset: { width: 0, height: on ? 10 : 6 },
                elevation: on ? 6 : 3,
                transform: [{ scale: pressed && !on ? 0.98 : 1 }],
              })}
            >
              <View
                style={{
                  width: v(56),
                  height: v(56),
                  borderRadius: 999,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: on ? 'rgba(255,255,255,0.22)' : '#EEF2FA',
                }}
              >
                {m === 'dine_in' ? (
                  <Image
                    source={{ uri: on ? utensils : utensilsNavy }}
                    contentFit="contain"
                    style={{ width: v(28), height: v(28) }}
                    accessible={false}
                    accessibilityLabel=""
                  />
                ) : (
                  <Icon name="bag-handle-outline" tone={on ? 'inverse' : 'navy'} />
                )}
              </View>
              <Text
                {...fixedText}
                numberOfLines={1}
                adjustsFontSizeToFit
                style={{
                  flex: 1,
                  fontFamily: fonts.black,
                  fontSize: Math.max(22, v(26)),
                  color: on ? colors.white : colors.navy,
                }}
              >
                {label(m)}
              </Text>
              <View
                style={{
                  width: v(34),
                  height: v(34),
                  borderRadius: 999,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: on ? colors.white : 'transparent',
                  borderWidth: on ? 0 : 2,
                  borderColor: colors.border,
                }}
              >
                {on ? <Icon name="checkmark" size="small" tone="accent" /> : null}
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
