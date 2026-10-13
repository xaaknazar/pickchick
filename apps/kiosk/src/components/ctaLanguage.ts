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

/** A caption's pose: its opacity and its lift in flip shifts (1 below, 0 in place, -1 above). */
export interface CtaPose {
  opacity: number;
  lift: number;
}
/** At rest the shown caption stands in place, opaque; the others wait below, transparent. */
export const ctaRestPose = (locale: Locale, shown: Locale): CtaPose =>
  locale === shown ? { opacity: 1, lift: 0 } : { opacity: 0, lift: 1 };
/** Every caption's rest pose for the shown language. */
export function ctaRestPoses(shown: Locale): Record<Locale, CtaPose> {
  const poses = {} as Record<Locale, CtaPose>;
  for (const locale of CTA_ORDER) poses[locale] = ctaRestPose(locale, shown);
  return poses;
}
/** One timing of a flip (milliseconds) towards `to`, run on the native driver. */
export interface CtaLeg {
  locale: Locale;
  prop: keyof CtaPose;
  to: number;
  delay: number;
  duration: number;
  curve: 'ease' | 'linear';
}
/**
 * What the caption does when the shown language or the rotation changes. Every caption first
 * takes a definite pose, so no value stays where a stopped flip froze it. Only a new language
 * while the caption rotates then flips: the old one leaves up and fades out in 120 ms, the new
 * one rises from below and fades in between 100 and 280 ms. Anything else (a chosen language,
 * Reduce Motion, the rotation stopping in the middle of a flip) puts every caption at rest.
 */
export function ctaCaptionMove(
  from: Locale,
  shown: Locale,
  animate: boolean,
): { start: Record<Locale, CtaPose>; legs: CtaLeg[] } {
  const flip = animate && from !== shown;
  const start = ctaRestPoses(flip ? from : shown);
  if (!flip) return { start, legs: [] };
  const { duration, outFade, inDelay } = CTA_FLIP;
  return {
    start,
    legs: [
      { locale: from, prop: 'opacity', to: 0, delay: 0, duration: outFade, curve: 'linear' },
      { locale: from, prop: 'lift', to: -1, delay: 0, duration, curve: 'ease' },
      {
        locale: shown,
        prop: 'opacity',
        to: 1,
        delay: inDelay,
        duration: duration - inDelay,
        curve: 'linear',
      },
      { locale: shown, prop: 'lift', to: 0, delay: 0, duration, curve: 'ease' },
    ],
  };
}
