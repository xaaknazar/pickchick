import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { CartTotal } from './CartTotal';
const meta = {
  title: 'Kiosk/CartTotal',
  component: CartTotal,
  args: { total: '299000', valid: true, locale: 'ru' },
  tags: ['autodocs'],
} satisfies Meta<typeof CartTotal>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
