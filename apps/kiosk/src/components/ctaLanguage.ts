import type { Locale } from '../i18n';

/**
 * Owner decision 2026-10-11 for the attract CTA: its caption takes turns in KZ -> RU -> EN, each
 * shown 2.4 s (a 7.2 s round, starting with KZ). The caption never chooses the order language:
 * a tap starts the order in the language of the switch (Russian by default). Once the guest
 * touches the switch, or under Reduce Motion, the caption stays in the switch language.
 */
export const CTA_ORDER: readonly Locale[] = ['kk', 'ru', 'en'];
/** How long each language stays on the button. */
export const CTA_STEP_MS = 2400;
/** Vertical flip without blur: the old caption leaves up and fades out in 120 ms, the new one
 * rises from below and fades in between 100 and 280 ms. */
export const CTA_FLIP = { duration: 280, outFade: 120, inDelay: 100, shift: 0.4 } as const;

export interface CtaLanguageState {
  /** The guest touched the language switch on the attract screen. */
  pinned: boolean;
  /** System Reduce Motion. */
  reduced: boolean;
  /** The app is in the foreground and the attract screen is shown. */
  active: boolean;
}
/** Whether the caption keeps rotating. */
export const ctaRotates = ({ pinned, reduced, active }: CtaLanguageState) =>
  !pinned && !reduced && active;
/** The language on the button: the rotation step, or the switch language once it stops. */
export const ctaShownLocale = (
  step: number,
  { pinned, reduced }: Pick<CtaLanguageState, 'pinned' | 'reduced'>,
  switchLocale: Locale,
): Locale => (pinned || reduced ? switchLocale : CTA_ORDER[step % CTA_ORDER.length]!);
export const nextCtaStep = (step: number) => (step + 1) % CTA_ORDER.length;
