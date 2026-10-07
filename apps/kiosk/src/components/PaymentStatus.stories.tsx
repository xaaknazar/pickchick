import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { PaymentStatus } from './PaymentStatus';
const meta = {
  title: 'Kiosk/PaymentStatus',
  component: PaymentStatus,
  args: {
    state: 'unknown',
    title: 'Уточняем результат оплаты',
    total: '299000',
    reference: 'Заказ 128',
    message: 'Не оплачивайте повторно. Пригласите сотрудника.',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof PaymentStatus>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Qr = {
  args: {
    state: 'waiting',
    title: 'Ожидаем оплату Kaspi',
    qrPayload: 'pickchick:storybook:not-a-payment',
  },
};
