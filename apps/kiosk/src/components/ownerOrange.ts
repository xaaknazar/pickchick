import { Platform } from 'react-native';
/**
 * Owner decision 2026-10-10: calls to action and active controls use the design orange
 * #FF6900 with white text (2.88:1), an approved exception to the WCAG AA contrast check.
 * Spread on the control that draws that fill; on the web (exported app, Storybook) it adds
 * `data-owner-orange`, which the accessibility checks use to excuse exactly that colour pair
 * (tests/kiosk/browser_mobbin.py, .storybook/preview.tsx). Nothing changes on iPad.
 */
export const ownerOrange: object =
  Platform.OS === 'web' ? { dataSet: { ownerOrange: '2026-10-10' } } : {};
