import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { PaymentQR } from './PaymentQR';
const meta = {
  title: 'Kiosk/PaymentQR',
  component: PaymentQR,
  args: { payload: 'pickchick:storybook:not-a-payment', label: 'Синтетический QR' },
  tags: ['autodocs'],
} satisfies Meta<typeof PaymentQR>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Scanning: Story = { args: { scanning: true } };
export const Compact: Story = { args: { size: 'compact', scanning: true } };
