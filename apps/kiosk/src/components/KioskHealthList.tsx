import { View } from 'react-native';
import { colors, useMetrics } from '../theme';
import { copy, type Locale } from '../i18n';
import type { KioskHealthLine } from '../kiosk-health';
import { Body } from './Body';

/**
 * Staff-only kiosk health line (stage 2, lane kln) inside the white staff dialog: one row per
 * fact. A fact a production iPad should not show is drawn in the error tone and named as such,
 * so it never depends on colour alone.
 */
export function KioskHealthList({ lines, locale }: { lines: KioskHealthLine[]; locale: Locale }) {
  const { px } = useMetrics();
  const t = copy(locale);
  return (
    <View testID="kiosk-health">
      {lines.map((line, index) => (
        <View
          key={line.id}
          testID={`kiosk-health-${line.id}`}
          accessible
          style={{
            gap: px(2),
            paddingVertical: px(10),
            borderTopWidth: index ? 1 : 0,
            borderColor: colors.border,
          }}
        >
          <Body variant="label" tone="navy">
            {line.label}
          </Body>
          <Body tone={line.attention ? 'danger' : 'default'}>{line.value}</Body>
          {line.attention ? (
            <Body variant="caption" tone="danger" testID={`kiosk-health-${line.id}-check`}>
              {t.healthCheck}
            </Body>
          ) : null}
        </View>
      ))}
    </View>
  );
}
