import { useState } from 'react';
import { View } from 'react-native';
import { money } from '../cart';
import type { Locale } from '../i18n';
import type { TerminalPaymentView } from '../model';
import { terminalCopy } from '../terminalCopy';
import { useMetrics } from '../theme';
import { Body } from './Body';
import { Button } from './Button';
import { Heading } from './Heading';
import { Icon, type IconName } from './Icon';
import { StaffHold } from './StaffHold';
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
  releasing: 'hourglass-outline',
  cancelling: 'close-circle-outline',
};
/**
 * ADR-0018: the payment step when the kiosk has its own Kaspi Smart POS. «Оплатите на терминале -
 * картой или Kaspi QR», the amount and a pointer to the terminal while the guest pays there; the
 * result, «В меню» (an empty menu, owner 22.11.2026) and «Повторить» after a failure, a
 * cancellation or a payment that did not start; a staff hold on the icon while the result is unknown
 * (never «pay again»). Owner 22.11.2026: while the terminal waits, «Отменить или изменить заказ»
 * opens the cart at once (`onEditNow`); the kiosk cannot cancel on the terminal, so paying the
 * changed order (`releasing`) or cancelling it (`cancelling`) waits here until the terminal is
 * free. For the blue surface.
 */
export function TerminalPayment({
  view,
  total,
  locale,
  busy = false,
  onRetry,
  onLeave,
  onEdit,
  onEditNow,
  onStaff,
}: {
  view: TerminalPaymentView;
  /** Order total in minor units (whole tenge on the terminal). */
  total: string;
  locale: Locale;
  busy?: boolean;
  onRetry?: () => void;
  onLeave?: () => void;
  /** Back to the cart with the same dishes (after a failure; the kiosk keeps the draft). */
  onEdit?: () => void;
  /** While the terminal waits (or is being waited for): the cart opens at once. */
  onEditNow?: () => void;
  /** Opens the staff dialog (staff code, then the service reset). */
  onStaff?: () => void;
}) {
  const t = terminalCopy(locale);
  const { px } = useMetrics();
  /** «В меню» and «Повторить» side by side at one width, so the pair reads as one even row. */
  // Wide enough for the label, its icon and the busy spinner on one line (owner 22.11.2026).
  const pair = Math.max(280, px(360));
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
            : view.phase === 'releasing'
              ? t.releasingTitle
              : view.phase === 'cancelling'
                ? t.cancellingTitle
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
                : view.phase === 'releasing'
                  ? t.releasing
                  : view.phase === 'cancelling'
                    ? t.cancelling
                    : t.lostBody;
  const retry =
    view.phase === 'failed' || view.phase === 'cancelled' || view.phase === 'not_started';
  // Owner 22.11.2026: no «Сотруднику» button for guests. While the result is unknown (money may
  // have moved) staff open their dialog by holding the icon above the title for five seconds.
  // Audit 23.11 #1: also after a failure the cloud could not be told (no internet): `onStaff`
  // is given only while the controller offers the service reset.
  const staff = view.phase === 'lost' || view.phase === 'checking' || retry;
  // Owner 22.11.2026: a way out while the terminal waits: the cart opens at once (`onEditNow`).
  // Without it (no such command) the button tells how to cancel on the terminal; once the
  // terminal reports the cancellation, «Изменить заказ» returns to the cart.
  const [asked, setAsked] = useState(false);
  const waiting = view.phase === 'waiting';
  const held = view.phase === 'releasing' || view.phase === 'cancelling';
  return (
    <Wrapper gap={26} align="center" width="100%" maxWidth={820} testID="kiosk-terminal-payment">
      <StaffHold onHold={staff ? onStaff : undefined} testID="kiosk-terminal-staff">
        <Icon name={ICONS[view.phase]} size="hero" tone="inverse" />
      </StaffHold>
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
      {view.phase === 'cancelling' ? null : (
        <Wrapper gap={4} align="center">
          <Body tone="onBlue" align="center">
            {t.toPay}
          </Body>
          <Heading size="hero" tone="inverse" align="center" testID="kiosk-terminal-amount">
            {money(total)}
          </Heading>
        </Wrapper>
      )}
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
        {view.offline && (paying || held || view.phase === 'checking' || view.phase === 'paid') ? (
          <Body tone="inverse" variant="caption" align="center" testID="kiosk-terminal-offline">
            {t.offline}
          </Body>
        ) : null}
      </Wrapper>
      {waiting && onEditNow ? (
        <Button
          label={t.cancelOrEdit}
          tone="outline"
          testID="kiosk-terminal-cancel-edit"
          icon="create-outline"
          iconLeading
          onPress={onEditNow}
        />
      ) : waiting && onEdit ? (
        asked ? (
          <Wrapper maxWidth={720}>
            <Body tone="inverse" align="center" announce testID="kiosk-terminal-cancel-hint">
              {t.cancelOnTerminal}
            </Body>
          </Wrapper>
        ) : (
          <Button
            label={t.cancelOrEdit}
            tone="outline"
            testID="kiosk-terminal-cancel-edit"
            icon="create-outline"
            iconLeading
            onPress={() => setAsked(true)}
          />
        )
      ) : null}
      {view.phase === 'releasing' && onEditNow ? (
        <Button
          label={t.leave}
          tone="outline"
          testID="kiosk-terminal-back"
          icon="arrow-back"
          iconLeading
          onPress={onEditNow}
        />
      ) : null}
      {retry && onEdit ? (
        <View style={{ width: pair * 2 + 14 }}>
          <Button
            label={t.editOrder}
            tone="accent"
            testID="kiosk-terminal-edit"
            icon="create-outline"
            iconLeading
            fullWidth
            disabled={busy}
            onPress={onEdit}
          />
        </View>
      ) : null}
      {retry ? (
        <Wrapper dir="row" gap={14} wrap justify="center">
          {retry && onLeave ? (
            <View style={{ width: pair }}>
              <Button
                label={t.toMenu}
                testID="kiosk-terminal-menu"
                icon="arrow-back"
                iconLeading
                fullWidth
                disabled={busy}
                onPress={onLeave}
              />
            </View>
          ) : null}
          {retry && onRetry ? (
            <View style={{ width: pair }}>
              <Button
                label={t.retry}
                tone="light"
                testID="kiosk-terminal-retry"
                icon="refresh"
                fullWidth
                busy={busy}
                onPress={onRetry}
              />
            </View>
          ) : null}
        </Wrapper>
      ) : null}
    </Wrapper>
  );
}
