import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { fn } from 'storybook/test';
import { colors } from '../theme';
import { CartBar } from './CartBar';
const meta = {
  title: 'Kiosk/CartBar',
  component: CartBar,
  decorators: [
    (Story) => (
      // Backdrop only: the cart pill floats over the blue v3 menu.
      <View style={{ backgroundColor: colors.blue }}>
        <Story />
      </View>
    ),
  ],
  args: {
    quantity: 1,
    total: '299000',
    valid: true,
    empty: false,
    busy: false,
    locale: 'ru',
    onCheckout: fn(),
  },
  tags: ['autodocs'],
} satisfies Meta<typeof CartBar>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Empty = { args: { quantity: 0, total: '0', empty: true } };
export const Invalid = { args: { valid: false } };
export const Busy = { args: { busy: true } };

export const Added = { args: { previousQuantity: 0, quantity: 2 } };
