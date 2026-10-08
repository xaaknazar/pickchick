import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { ScreenSurface } from './ScreenSurface';
import { Wrapper } from './Wrapper';
import { PaymentStatus } from './PaymentStatus';
const meta = {
  title: 'Kiosk/PaymentStatus',
  component: PaymentStatus,
  decorators: [
    (Story) => (
      <ScreenSurface tone="brand">
        <Wrapper flex={1} paddingX={60} paddingY={34} justify="center">
          <Story />
        </Wrapper>
      </ScreenSurface>
    ),
  ],
  args: {
    state: 'unknown',
    title: 'Уточняем результат оплаты',
    total: '299000',
    reference: 'Заказ 128',
    message: 'Не оплачивайте повторно. Пригласите сотрудника.',
    locale: 'ru',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof PaymentStatus>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Qr: Story = {
  args: {
    state: 'waiting',
    title: 'Ожидаем оплату Kaspi',
    method: 'qr',
    qrPayload: 'pickchick:storybook:not-a-payment',
    expiresAt: new Date(Date.now() + 272000).toISOString(),
  },
};
export const QrKk: Story = {
  args: {
    ...Qr.args,
    locale: 'kk',
    title: 'Kaspi төлемін күтеміз',
    reference: 'Тапсырыс 128',
  },
};
export const Invoice: Story = {
  args: {
    state: 'waiting',
    title: 'Ожидаем оплату Kaspi',
    method: 'invoice',
    message:
      'Счёт отправлен. Откройте Kaspi.kz на своём телефоне и подтвердите оплату. Этот экран обновится автоматически.',
  },
};
export const Declined: Story = {
  args: { state: 'declined', title: 'Оплата отклонена', message: 'Попробуйте ещё раз.' },
};
