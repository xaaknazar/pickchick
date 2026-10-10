import type { Preview } from '@storybook/react-native-web-vite';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { KioskFonts } from '../src/components/KioskFonts';
import { ScreenSurface } from '../src/components/ScreenSurface';
import './preview.css';
const OWNER_ORANGE = '[data-owner-orange="2026-10-10"]';
interface AxeColor {
  toHexString(): string;
}
interface AxeGlobal {
  commons: {
    color: {
      getBackgroundColor(node: Element, stack: Element[]): AxeColor | null;
      getForegroundColor(node: Element, noScroll: boolean, bg: AxeColor): AxeColor | null;
      getContrast(bg: AxeColor, fg: AxeColor): number;
    };
  };
}
/** WCAG AA text contrast, except white text on the design orange (owner decision). */
function ownerOrangeContrast(this: { data(value: unknown): void }, node: Element) {
  const { color } = (globalThis as unknown as { axe: AxeGlobal }).axe.commons;
  if (!node.textContent?.trim()) return true;
  const bg = color.getBackgroundColor(node, []);
  const fg = bg ? color.getForegroundColor(node, false, bg) : null;
  // Unknown colours (images, gradients) need review, as in the built-in rule.
  if (!bg || !fg) return undefined;
  const pair = [bg.toHexString().toLowerCase(), fg.toHexString().toLowerCase()];
  this.data({ bgColor: pair[0], fgColor: pair[1] });
  if (pair[0] === '#ff6900' && pair[1] === '#ffffff') return true;
  const style = getComputedStyle(node);
  const size = parseFloat(style.fontSize);
  const large = size >= 24 || (Number(style.fontWeight) >= 700 && size >= 18.66);
  return color.getContrast(bg, fg) >= (large ? 3 : 4.5);
}
const ownerOrangeAxe = {
  checks: [{ id: 'owner-orange-contrast', evaluate: ownerOrangeContrast }],
  rules: [
    { id: 'color-contrast', selector: `*:not(${OWNER_ORANGE} *)` },
    {
      id: 'owner-orange-contrast',
      selector: `${OWNER_ORANGE} *`,
      matches: 'color-contrast-matches',
      tags: ['wcag2aa', 'wcag143'],
      any: ['owner-orange-contrast'],
      all: [],
      none: [],
      metadata: {
        description: 'Text contrast inside owner-orange controls (only #FFFFFF on #FF6900 excused)',
        help: 'Elements must meet WCAG AA contrast; only white on #FF6900 is excused',
      },
    },
  ],
};
const preview: Preview = {
  decorators: [
    (Story) => (
      <SafeAreaProvider>
        <KioskFonts>
          <ScreenSurface testID="kiosk-story-content">
            <Story />
          </ScreenSurface>
        </KioskFonts>
      </SafeAreaProvider>
    ),
  ],
  parameters: {
    layout: 'fullscreen',
    a11y: {
      test: 'error',
      // Owner decision 2026-10-10: CTAs and active controls keep the design orange #FF6900
      // under white text. Like CI (tests/kiosk/browser_mobbin.py), only that exact colour
      // pair inside a component marked by components/ownerOrange.ts is excused: there the
      // built-in colour-contrast rule is replaced by the same WCAG AA check that passes
      // #FFFFFF on #FF6900 and nothing else.
      config: ownerOrangeAxe,
    },
    viewport: {
      options: {
        ipad: { name: 'iPad 10.9 portrait', styles: { width: '820px', height: '1180px' } },
        ipadMini: { name: 'iPad 768 portrait', styles: { width: '768px', height: '1024px' } },
        ipadPro: { name: 'iPad Pro portrait', styles: { width: '1024px', height: '1366px' } },
        landscape: {
          name: 'iPad landscape fallback',
          styles: { width: '1180px', height: '820px' },
        },
      },
    },
    controls: { expanded: true },
  },
  initialGlobals: { viewport: { value: 'ipad', isRotated: false } },
};
export default preview;
