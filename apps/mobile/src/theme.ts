import tokens from '../../../packages/design-tokens/tokens.json';
import { tabBarLight, tabBarNavy, tabBarPalette } from './tab-bar-metrics';

export const brandColors = tokens.color;

/**
 * Owner 23.11.2026: three looks the guest picks in «Оформление» - «Светлая», «Тёмная» and
 * «Синяя» (the original navy) - plus «Как в системе», the default, which follows the phone's
 * light or dark mode. Every screen reads its colours from the active palette below; games keep
 * their own art in every theme.
 */
export type ThemeName = 'light' | 'dark' | 'blue';
export type ThemePreference = 'system' | ThemeName;
export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark', 'blue'];

const dark = {
  ...tokens.theme.mobile,
  raised: tokens.theme.mobile.surfaceRaised,
  border: '#283247',
  orangeInk: '#251609',
  /** Primary text and icons on the page and cards (white on the dark looks). */
  white: '#FFFFFF',
  /** Literal white: text and icons on orange/blue buttons, photos and video. */
  pure: '#FFFFFF',
  /** Light window behind cut-out food photos. */
  photo: '#EEF2F8',
  /** Hairline borders and quiet fills on cards: white at low alpha on the dark looks. */
  hairline: '#FFFFFF0D',
  success: '#ADEDD1',
  warning: '#FFE2C3',
  warningSurface: '#4B311D',
  danger: '#FFDBE5',
  dangerSurface: '#4D2434',
  /** Status bar text and native controls (date wheel, glass) follow this. */
  scheme: 'dark' as 'dark' | 'light',
};
export type Palette = typeof dark;

const blue: Palette = {
  ...dark,
  background: '#04143A',
  surface: '#0B2255',
  surfaceRaised: '#14306B',
  raised: '#14306B',
  muted: '#93A6C9',
  border: '#203561',
};

const light: Palette = {
  ...dark,
  background: '#E4EDFB',
  surface: '#FFFFFF',
  surfaceRaised: '#F1F5FC',
  raised: '#F1F5FC',
  text: '#0F1B3D',
  muted: '#56627A',
  action: '#0047BB',
  accentText: '#B84800',
  border: '#D3DCEA',
  white: '#0F1B3D',
  hairline: '#0F1B3D14',
  success: '#0B6B45',
  warning: '#8A4B00',
  warningSurface: '#FFEBD6',
  danger: '#B3261E',
  dangerSurface: '#FDE7EA',
  scheme: 'light',
};

export const palettes: Record<ThemeName, Palette> = { light, dark, blue };

/** The active palette. Mutated in place by `applyTheme`, so read it at render time. */
export const colors: Palette = { ...dark };

export const font = {
  heading: 'Jost_600SemiBold',
  display: 'Jost_700Bold',
  body: 'Manrope_400Regular',
  medium: 'Manrope_600SemiBold',
  bold: 'Manrope_700Bold',
};
export const spacing = { page: tokens.spacing[3] ?? 16, gap: 12, card: 20 };

const restaurantBase = {
  open: '#5FD3A0',
  closed: '#FFB777',
  divider: '#222B3F',
  outline: '#313C55',
  mapControl: 'rgba(10,16,32,0.88)',
};
/** Extras approved for «Наши рестораны» (M05) in the 2026-10-12 redesign brief. */
export const restaurantColors = { ...restaurantBase };

let activeTheme: ThemeName = 'dark';
let version = 0;
const listeners = new Set<() => void>();

/** For useSyncExternalStore: every screen that calls `useLocale()` re-renders on a switch. */
export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function currentTheme(): ThemeName {
  return activeTheme;
}
export function themeVersion(): number {
  return version;
}

/** Switches every palette in place. Screens re-render through ThemeProvider. */
export function applyTheme(name: ThemeName): void {
  if (name === activeTheme && version > 0) return;
  activeTheme = name;
  Object.assign(colors, palettes[name]);
  Object.assign(restaurantColors, {
    open: tc(restaurantBase.open),
    closed: tc(restaurantBase.closed),
    divider: tc(restaurantBase.divider),
    outline: tc(restaurantBase.outline),
    mapControl: tc(restaurantBase.mapControl),
  });
  Object.assign(tabBarPalette, name === 'light' ? tabBarLight : tabBarNavy);
  version += 1;
  listeners.forEach((listener) => listener());
}

/** «Как в системе»: light or dark from the phone; the navy look is never automatic. */
export function resolveTheme(
  preference: ThemePreference,
  system: 'light' | 'dark' | null | undefined,
): ThemeName {
  if (preference !== 'system') return preference;
  return system === 'light' ? 'light' : 'dark';
}

/**
 * Styles that read the palette. The factory runs again after a theme switch, the first time a
 * style is read; components read `s.name` during render, so they get the active theme's values.
 */
export function themed<T extends object>(make: () => T): T {
  let cache: T | null = null;
  let builtFor = -1;
  const current = () => {
    if (cache === null || builtFor !== version) {
      cache = make();
      builtFor = version;
    }
    return cache;
  };
  return new Proxy({} as T, {
    get: (_target, key) => (current() as Record<string | symbol, unknown>)[key],
    has: (_target, key) => key in current(),
    ownKeys: () => Reflect.ownKeys(current()),
    getOwnPropertyDescriptor: (_target, key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(current(), key);
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Literal colours written for the dark look (screens drawn before themes existed). `tc` maps them
// to the active theme: unchanged on «Тёмная», the original navy on «Синяя», and on «Светлая»
// dark surfaces become light ones and light text becomes dark text, keeping the hue.

type Rgba = [number, number, number, number];

const BLUE_MAP: Record<string, string> = {
  '0a1020': '04143a',
  '141b2b': '0b2255',
  '1c2538': '14306b',
  '283247': '203561',
  '98a2b3': '93a6c9',
  '222b3f': '1b2e5a',
  '313c55': '2a3e66',
};
const LIGHT_MAP: Record<string, string> = {
  '0a1020': 'e4edfb',
  '141b2b': 'ffffff',
  '1c2538': 'f1f5fc',
  '283247': 'd3dcea',
  '222b3f': 'e3e9f3',
  '313c55': 'c9d3e3',
  ffffff: '0f1b3d',
  f2f6ff: '0f1b3d',
  '98a2b3': '56627a',
  a3b4d6: '4a5875',
  ff8a3d: 'b84800',
};

const COLOR =
  /#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3})\b|rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/gi;

function hex2(n: number) {
  return Math.round(Math.max(0, Math.min(255, n)))
    .toString(16)
    .padStart(2, '0');
}

function parse(match: RegExpExecArray | string[]): Rgba {
  if (match[1]) {
    let h = match[1].toLowerCase();
    if (h.length === 3) h = h.replace(/./g, (c) => c + c);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
      a,
    ];
  }
  return [
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    match[5] === undefined ? 1 : Number(match[5]),
  ];
}

function toHsl([r, g, b]: Rgba): [number, number, number] {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [h / 6, s, l];
}

function fromHsl(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

function format([r, g, b, a]: Rgba, asRgba: boolean): string {
  if (asRgba || a < 1) {
    if (!asRgba) return `#${hex2(r)}${hex2(g)}${hex2(b)}${hex2(a * 255)}`.toUpperCase();
    return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${+a.toFixed(3)})`;
  }
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`.toUpperCase();
}

/** One colour written for the dark look, on the light look. Exported for unit tests. */
export function lightColor(input: Rgba): Rgba {
  const [r, g, b, a] = input;
  const key = `${hex2(r)}${hex2(g)}${hex2(b)}`;
  const mapped = LIGHT_MAP[key];
  if (mapped)
    return [
      parseInt(mapped.slice(0, 2), 16),
      parseInt(mapped.slice(2, 4), 16),
      parseInt(mapped.slice(4, 6), 16),
      a,
    ];
  const [h, s, l] = toHsl(input);
  // Pure black (scrims behind sheets and over photos) stays black.
  if (r === 0 && g === 0 && b === 0) return input;
  // Saturated brand and status colours (orange, blue, green, red) keep their look.
  if (s > 0.55 && l > 0.3 && l < 0.72) return input;
  if (l <= 0.42) {
    // Dark surfaces -> light surfaces of the same hue.
    const nl = 0.9 + l * 0.22;
    const [R, G, B] = fromHsl(h, Math.min(s, 0.6), Math.min(nl, 0.99));
    return [R, G, B, a];
  }
  // White at low alpha (hairlines, quiet fills) -> ink at the same alpha.
  if (a < 1 && l > 0.85) return [15, 27, 61, a];
  // Light text and icons -> dark text of the same hue.
  const nl = Math.max(0.14, Math.min(0.42, 1 - l));
  const [R, G, B] = fromHsl(h, Math.min(Math.max(s, 0.25), 0.6), nl);
  return [R, G, B, a];
}

function blueColor(input: Rgba): Rgba {
  const [r, g, b, a] = input;
  const mapped = BLUE_MAP[`${hex2(r)}${hex2(g)}${hex2(b)}`];
  if (!mapped) return input;
  return [
    parseInt(mapped.slice(0, 2), 16),
    parseInt(mapped.slice(2, 4), 16),
    parseInt(mapped.slice(4, 6), 16),
    a,
  ];
}

/** Maps every colour inside `value` (a colour or a CSS gradient) to the active theme. */
export function tc(value: string, theme: ThemeName = activeTheme): string {
  if (theme === 'dark') return value;
  return value.replace(COLOR, (...args) => {
    const match = args.slice(0, 6) as string[];
    const rgba = parse(match);
    const next = theme === 'light' ? lightColor(rgba) : blueColor(rgba);
    return format(next, String(match[0]).toLowerCase().startsWith('rgb'));
  });
}

applyTheme('dark');
