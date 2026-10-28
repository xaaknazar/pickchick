// Owner redesign 27.10.2026 (Drinkit pattern): one header row on Меню, События and Заказы, with
// the round profile button at the right gutter. Pure geometry so the header, the profile top bar
// and unit tests share one source and the button cannot drift between tabs.

export const appHeaderMetrics = {
  /** Side gutter of the row; the profile button touches the right one. */
  gutter: 18,
  /** One width cap for every tab (the same as the page header), centred on wider screens. */
  maxWidth: 760,
  /** Round glass profile button in the header (owner 28.10.2026: «сделай размером больше»). */
  profileSize: 54,
  /** Back and settings on the profile screen keep their size and right edge under the header button. */
  profileBarSize: 46,
  logoSize: 38,
  /** Text follows Dynamic Type up to this factor and keeps the row one line high. */
  maxFontScale: 1.35,
} as const;

/**
 * Floor of the iOS shrink-to-fit of the hours caption (owner 28.10.2026: «откроемся завтра в
 * 10:00» on a 320 pt phone with the largest text): the caption shrinks back at most to its normal
 * size, never below it, so a caption that fits at the normal text size fits at every size.
 */
export const appHeaderCaptionMinScale = 1 / appHeaderMetrics.maxFontScale;

/** Horizontal frame of the profile button in a window `screenWidth` points wide. */
export function appHeaderProfileFrame(screenWidth: number) {
  const row = Math.min(screenWidth, appHeaderMetrics.maxWidth);
  const right = (screenWidth - row) / 2 + row - appHeaderMetrics.gutter;
  return { x: right - appHeaderMetrics.profileSize, width: appHeaderMetrics.profileSize, right };
}
