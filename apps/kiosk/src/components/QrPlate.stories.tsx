import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { ScreenSurface } from './ScreenSurface';
import { RadialBackdrop } from './RadialBackdrop';
import { Wrapper } from './Wrapper';
import { QrPlate } from './QrPlate';
const meta = {
  title: 'Kiosk/Redesign/QrPlate',
  component: QrPlate,
  decorators: [
    (Story) => (
      <ScreenSurface tone="brand">
        <RadialBackdrop />
        <Wrapper flex={1} align="center" justify="center">
          <Story />
        </Wrapper>
      </ScreenSurface>
    ),
  ],
  args: {
    // Synthetic text, not a payment.
    payload: 'pickchick:storybook:not-a-payment',
    label: 'Kaspi QR',
    message: 'Готовим QR или проверяем результат оплаты. Не оплачивайте повторно.',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof QrPlate>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
/** The bank has not returned the code yet. */
export const Preparing: Story = { args: { payload: null } };
/** The code lapsed on the local clock; the result is still being checked. */
export const Expired: Story = {
  args: {
    payload: null,
    expired: true,
    message: 'Время действия QR истекло. Проверяем результат оплаты. Не оплачивайте повторно.',
  },
};
/** Staff demo mode: a code that cannot be paid, smaller to leave room for the demo controls. */
export const Demo: Story = {
  args: {
    payload: 'PICKCHICK-DEMO-NOT-PAYABLE',
    demoWarning: 'ДЕМО - не оплачивать. Это не настоящий QR Kaspi.',
    compact: true,
  },
};
