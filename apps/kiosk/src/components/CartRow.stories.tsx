import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { fn } from 'storybook/test';
import { catalog, line } from '../stories/fixtures';
import { Wrapper } from './Wrapper';
import { CartRow } from './CartRow';
import { colors } from '../theme';
const meta = {
  title: 'Kiosk/CartRow',
  component: CartRow,
  decorators: [
    (Story) => (
      // Backdrop only: cart lines sit on the blue v3 cart screen.
      <View style={{ flex: 1, backgroundColor: colors.blue }}>
        <Wrapper padding={28}>
          <Story />
        </Wrapper>
      </View>
    ),
  ],
  args: { line, locale: 'ru', busy: false, onQuantity: fn() },
  tags: ['autodocs'],
} satisfies Meta<typeof CartRow>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const LongModifiers = { args: { line: { ...line, quantity: 20 } } };
export const Busy = { args: { busy: true } };
/** A line the cart already dropped: it slides out, untouchable and without ids. */
export const Leaving = { args: { leaving: true, onLeft: fn() } };
export const Extra = {
  args: {
    line: {
      ...line,
      lineId: 'story-toast',
      productId: 'toast',
      selections: [],
      product: catalog.products.find((p) => p.id === 'toast')!,
    },
  },
};
