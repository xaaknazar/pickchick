// Owner redesign 27.10.2026 (Drinkit pattern): one header row on Меню, События and Заказы, with
// the round profile button at the right gutter. Pure geometry so the header, the profile top bar
// and unit tests share one source and the button cannot drift between tabs.

export const appHeaderMetrics = {
  /** Side gutter of the row; the profile button touches the right one. */
  gutter: 18,
  /** One width cap for every tab (the same as the page header), centred on wider screens. */
  maxWidth: 760,
  /** Round glass profile button (owner 27.10.2026: 44-46 pt), above the 44 pt touch target. */
  profileSize: 46,
  logoSize: 38,
  /** Text follows Dynamic Type up to this factor and keeps the row one line high. */
  maxFontScale: 1.35,
} as const;

/** Horizontal frame of the profile button in a window `screenWidth` points wide. */
export function appHeaderProfileFrame(screenWidth: number) {
  const row = Math.min(screenWidth, appHeaderMetrics.maxWidth);
  const right = (screenWidth - row) / 2 + row - appHeaderMetrics.gutter;
  return { x: right - appHeaderMetrics.profileSize, width: appHeaderMetrics.profileSize, right };
}
