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
export const Footer: Story = { args: { size: 'large', count: 3, qr: true } };
export const Invalid: Story = { args: { size: 'large', count: 1, valid: false } };
export const Kazakh: Story = { args: { size: 'large', count: 2, qr: true, locale: 'kk' } };
