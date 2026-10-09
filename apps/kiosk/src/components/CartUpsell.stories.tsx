import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { fn } from 'storybook/test';
import { catalog } from '../stories/fixtures';
import { CartUpsell } from './CartUpsell';
import { colors } from '../theme';
const meta = {
  title: 'Kiosk/CartUpsell',
  component: CartUpsell,
  decorators: [
    (Story) => (
      // Backdrop only: the inline upsell card sits on the blue v3 cart.
      <View style={{ flex: 1, padding: 24, backgroundColor: colors.blue }}>
        <Story />
      </View>
    ),
  ],
  args: {
    products: catalog.products.filter((p) => catalog.upsell_product_ids.includes(p.id)),
    addedIds: [],
    busy: false,
    locale: 'ru',
    onAdd: fn(),
  },
  tags: ['autodocs'],
} satisfies Meta<typeof CartUpsell>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Added: Story = { args: { addedIds: ['toast'] } };
