import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { fn } from 'storybook/test';
import { catalog, line } from '../stories/fixtures';
import { colors } from '../theme';
import type { KioskCartLine } from '../model';
import { Wrapper } from './Wrapper';
import { CartLines } from './CartLines';
const toast: KioskCartLine = {
  ...line,
  lineId: 'story-toast',
  productId: 'toast',
  selections: [],
  product: catalog.products.find((p) => p.id === 'toast')!,
};
const meta = {
  title: 'Kiosk/CartLines',
  component: CartLines,
  decorators: [
    (Story) => (
      // Backdrop only: cart lines sit on the blue v3 cart screen.
      <View style={{ flex: 1, backgroundColor: colors.blue }}>
        <Wrapper padding={28} gap={14}>
          <Story />
        </Wrapper>
      </View>
    ),
  ],
  args: { lines: [line, toast], locale: 'ru', busy: false, onQuantity: fn() },
  tags: ['autodocs'],
} satisfies Meta<typeof CartLines>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
/** Live cart: "Удалить" (or minus at 1) slides the line out, then the list closes up. */
export const Removing: Story = {
  render: function Render(args) {
    const [lines, setLines] = useState(args.lines);
    return (
      <CartLines
        {...args}
        lines={lines}
        onQuantity={(lineId, quantity) =>
          setLines((now) =>
            quantity > 0
              ? now.map((l) => (l.lineId === lineId ? { ...l, quantity } : l))
              : now.filter((l) => l.lineId !== lineId),
          )
        }
      />
    );
  },
};
