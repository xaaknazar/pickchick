import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { Wrapper } from './Wrapper';
import { UpsellQuantity } from './UpsellQuantity';
const meta = {
  title: 'Kiosk/Redesign/UpsellQuantity',
  component: UpsellQuantity,
  decorators: [
    (Story) => (
      <Wrapper padding={24}>
        <Story />
      </Wrapper>
    ),
  ],
  args: {
    productId: 'sauce',
    name: 'Соус фирменный',
    quantity: 0,
    busy: false,
    locale: 'ru',
    onIncrease: fn(),
    onDecrease: fn(),
  },
} satisfies Meta<typeof UpsellQuantity>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Empty: Story = {};
export const Five: Story = { args: { quantity: 5 } };
export const Busy: Story = { args: { quantity: 2, busy: true } };
export const Limit: Story = { args: { quantity: 20, increaseDisabled: true } };
export const Interactive: Story = {
  render: function QuantityStory(args) {
    const [quantity, setQuantity] = useState(1);
    return (
      <UpsellQuantity
        {...args}
        quantity={quantity}
        increaseDisabled={quantity >= 20}
        onIncrease={() => setQuantity((n) => n + 1)}
        onDecrease={() => setQuantity((n) => Math.max(0, n - 1))}
      />
    );
  },
};
