import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { ScreenSurface } from './ScreenSurface';
import { Wrapper } from './Wrapper';
import { TerminalPayment } from './TerminalPayment';
/** ADR-0018: payment on the kiosk's own Kaspi Smart POS. Synthetic states; nothing is paid. */
const meta = {
  title: 'Kiosk/TerminalPayment',
  component: TerminalPayment,
  decorators: [
    (Story) => (
      <ScreenSurface tone="brand">
        <Wrapper flex={1} paddingX={60} paddingY={34} align="center" justify="center">
          <Story />
        </Wrapper>
      </ScreenSurface>
    ),
  ],
  args: {
    view: { phase: 'waiting', reason: null, offline: false, subStatus: 'WaitUser' },
    total: '419000',
    locale: 'ru',
    onRetry: fn(),
    onLeave: fn(),
    onEditNow: fn(),
    onStaff: fn(),
  },
  tags: ['autodocs'],
} satisfies Meta<typeof TerminalPayment>;
export default meta;
type Story = StoryObj<typeof meta>;
/** «Оплатите на терминале - картой или Kaspi QR» with the amount and the pointer. */
export const PayOnTerminal: Story = {};
export const PayOnTerminalKk: Story = { args: { locale: 'kk' } };
export const PayOnTerminalEn: Story = { args: { locale: 'en' } };
export const Starting: Story = {
  args: { view: { phase: 'starting', reason: null, offline: false, subStatus: null } },
};
/** Waiting, the last status read did not answer: the screen keeps asking. */
export const WaitingOffline: Story = {
  args: { view: { phase: 'waiting', reason: null, offline: true, subStatus: 'WaitUser' } },
};
export const Checking: Story = {
  args: { view: { phase: 'checking', reason: null, offline: false, subStatus: null } },
};
export const Paid: Story = {
  args: {
    view: { phase: 'paid', reason: null, offline: false, subStatus: 'CardTransactionSuccess' },
  },
};
export const Failed: Story = {
  args: {
    view: { phase: 'failed', reason: null, offline: false, subStatus: 'CardTransactionFailure' },
  },
};
/** The guest cancelled on the terminal (subStatus ProcessCancelled). */
export const Cancelled: Story = {
  args: {
    view: { phase: 'cancelled', reason: null, offline: false, subStatus: 'ProcessCancelled' },
  },
};
/** The guest changed the order and pressed pay while the terminal still held the old sum. */
export const Releasing: Story = {
  args: { view: { phase: 'releasing', reason: null, offline: false, subStatus: null } },
};
/** The guest cancelled while changing the order: the kiosk waits for the terminal to let go. */
export const Cancelling: Story = {
  args: { view: { phase: 'cancelling', reason: null, offline: false, subStatus: null } },
};
/** Error 107: a previous operation is not finished on the terminal. */
export const TerminalBusy: Story = {
  args: { view: { phase: 'not_started', reason: 'busy', offline: false, subStatus: null } },
};
export const TerminalUnreachable: Story = {
  args: {
    view: { phase: 'not_started', reason: 'unreachable', offline: false, subStatus: null },
    locale: 'en',
  },
};
/** Sent without an answer: never repeated, staff checks the terminal. */
export const Lost: Story = {
  args: { view: { phase: 'lost', reason: null, offline: false, subStatus: null } },
};
export const RetryInProgress: Story = {
  args: {
    view: { phase: 'failed', reason: null, offline: false, subStatus: null },
    busy: true,
  },
};
