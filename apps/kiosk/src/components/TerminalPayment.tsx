import { money } from '../cart';
import type { Locale } from '../i18n';
import type { TerminalPaymentView } from '../model';
import { terminalCopy } from '../terminalCopy';
import { Body } from './Body';
import { Button } from './Button';
import { Heading } from './Heading';
import { Icon, type IconName } from './Icon';
import { Wrapper } from './Wrapper';
const ICONS: Record<TerminalPaymentView['phase'], IconName> = {
  starting: 'hourglass-outline',
  waiting: 'card-outline',
  checking: 'time-outline',
  paid: 'checkmark-circle-outline',
  failed: 'close-circle-outline',
  cancelled: 'close-circle-outline',
  not_started: 'alert-circle-outline',
  lost: 'time-outline',
};
/**
 * ADR-0018: the payment step when the kiosk has its own Kaspi Smart POS. «Оплатите на терминале -
 * картой или Kaspi QR», the amount and a pointer to the terminal while the guest pays there; the
 * result, «Повторить» and «Вернуться к заказу» after a failure or a payment that did not start;
 * «Сотруднику» while only staff can check the terminal (never «pay again»). For the blue surface.
 */
export function TerminalPayment({
  view,
  total,
  locale,
  busy = false,
  onRetry,
  onLeave,
  onStaff,
}: {
  view: TerminalPaymentView;
  /** Order total in minor units (whole tenge on the terminal). */
  total: string;
  locale: Locale;
  busy?: boolean;
  onRetry?: () => void;
  onLeave?: () => void;
  /** Opens the staff dialog (staff code, then the service reset). */
  onStaff?: () => void;
}) {
  const t = terminalCopy(locale);
  const paying = view.phase === 'starting' || view.phase === 'waiting';
  const title =
    view.phase === 'failed'
      ? t.failedTitle
      : view.phase === 'cancelled'
        ? t.cancelledTitle
        : view.phase === 'not_started'
          ? t.notStartedTitle
          : view.phase === 'lost' || view.phase === 'checking'
            ? t.lostTitle
            : t.title;
  const message =
    view.phase === 'starting'
      ? t.starting
      : view.phase === 'waiting'
        ? t.waiting
        : view.phase === 'checking'
          ? t.checking
          : view.phase === 'paid'
            ? t.paid
            : view.phase === 'failed' || view.phase === 'cancelled'
              ? t.failedBody
              : view.phase === 'not_started'
                ? `${t[`reason_${view.reason ?? 'refused'}`]} ${t.notStartedBody}`
                : t.lostBody;
  const retry =
    view.phase === 'failed' || view.phase === 'cancelled' || view.phase === 'not_started';
  const staff = view.phase === 'lost' || view.phase === 'checking' || view.phase === 'not_started';
  return (
    <Wrapper gap={26} align="center" width="100%" maxWidth={820} testID="kiosk-terminal-payment">
      <Icon name={ICONS[view.phase]} size="hero" tone="inverse" />
      <Wrapper gap={8} align="center">
        <Heading size="display" tone="inverse" align="center" testID="kiosk-terminal-title">
          {title}
        </Heading>
        {paying ? (
          <Heading size="section" tone="inverse" align="center">
            {t.subtitle}
          </Heading>
        ) : null}
      </Wrapper>
      <Wrapper gap={4} align="center">
        <Body tone="onBlue" align="center">
          {t.toPay}
        </Body>
        <Heading size="hero" tone="inverse" align="center" testID="kiosk-terminal-amount">
          {money(total)}
        </Heading>
      </Wrapper>
      {paying ? (
        <Wrapper dir="row" gap={12} align="center" justify="center">
          <Icon name="arrow-down-circle-outline" size="large" tone="inverse" />
          <Body tone="inverse" variant="label">
            {t.pointer}
          </Body>
        </Wrapper>
      ) : null}
      <Wrapper maxWidth={720} gap={10}>
        <Body tone="onBlue" align="center" announce testID="kiosk-terminal-message">
          {message}
        </Body>
        {view.offline && (paying || view.phase === 'checking' || view.phase === 'paid') ? (
          <Body tone="inverse" variant="caption" align="center" testID="kiosk-terminal-offline">
            {t.offline}
          </Body>
        ) : null}
      </Wrapper>
      {retry || staff ? (
        <Wrapper dir="row" gap={14} wrap justify="center">
          {retry && onRetry ? (
            <Button
              label={t.retry}
              testID="kiosk-terminal-retry"
              icon="refresh"
              busy={busy}
              onPress={onRetry}
            />
          ) : null}
          {retry && onLeave ? (
            <Button
              label={t.leave}
              tone="light"
              testID="kiosk-terminal-leave"
              disabled={busy}
              onPress={onLeave}
            />
          ) : null}
          {staff && onStaff ? (
            <Button
              label={t.staff}
              tone="outline"
              testID="kiosk-terminal-staff"
              disabled={busy}
              onPress={onStaff}
            />
          ) : null}
        </Wrapper>
      ) : null}
    </Wrapper>
  );
}
