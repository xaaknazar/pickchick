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
    receipt,
    locale: 'ru',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof OrderTicket>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Pending = { args: { confirmed: false, status: 'Ожидаем подтверждение' } };
