import { useState } from 'react';
import { Pressable } from 'react-native';
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
/** A changing total counts to its new value (380 ms). */
export const Counting: Story = {
  args: { size: 'large', count: 2 },
  render: function CountingStory(args) {
    const [total, setTotal] = useState('299000');
    return (
      <Pressable onPress={() => setTotal((now) => (now === '299000' ? '548000' : '299000'))}>
        <CartTotal {...args} total={total} />
      </Pressable>
    );
  },
};
export const Kazakh: Story = { args: { size: 'large', count: 2, qr: true, locale: 'kk' } };
