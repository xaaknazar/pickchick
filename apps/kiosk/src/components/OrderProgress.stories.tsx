import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { OrderProgress } from './OrderProgress';
const meta = {
  title: 'Kiosk/OrderProgress',
  component: OrderProgress,
  args: { step: 'menu', locale: 'ru' },
  tags: ['autodocs'],
} satisfies Meta<typeof OrderProgress>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Payment = { args: { step: 'payment' } };
