import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { receipt } from '../stories/fixtures';
import { ScreenSurface } from './ScreenSurface';
import { OrderTicket } from './OrderTicket';
const meta = {
  title: 'Kiosk/OrderTicket',
  component: OrderTicket,
  decorators: [
    (Story) => (
      <ScreenSurface tone="brand">
        <Story />
      </ScreenSurface>
    ),
  ],
  args: {
    number: '128',
    status: 'Готовим ваш заказ',
    confirmed: true,
    showBoard: true,
    stage: 'preparing',
    receipt,
    locale: 'ru',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof OrderTicket>;
export default meta;
type Story = StoryObj<typeof meta>;
/**
 * Opens paid: the green "paid" card (fade, disc pop, check draw) holds for 1 s,
 * then the logo drops, the number stamps in with its orange shadow, food
 * cut-outs burst from it and the bar fills with a passing shine.
 */
export const Default: Story = {};
export const Pending: Story = {
  args: { confirmed: false, stage: 'accepted', showBoard: false, status: 'Ожидаем подтверждение' },
};
export const Ready: Story = { args: { stage: 'ready', status: 'Заказ готов' } };
export const Kazakh: Story = {
  args: { locale: 'kk', status: 'Тапсырысыңыз дайындалуда' },
};
export const Cancelled: Story = {
  args: { stage: null, confirmed: false, showBoard: false, status: 'Заказ отменён' },
};
