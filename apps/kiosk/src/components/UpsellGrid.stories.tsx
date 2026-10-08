import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { fn } from 'storybook/test';
import { catalog } from '../stories/fixtures';
import { UpsellGrid } from './UpsellGrid';
import { colors } from '../theme';
const meta = {
  title: 'Kiosk/UpsellGrid',
  component: UpsellGrid,
  decorators: [
    (Story) => (
      // Backdrop only: the upsell grid is drawn for the blue v3 surface.
      <View style={{ flex: 1, backgroundColor: colors.blue }}>
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
    onInteraction: fn(),
  },
  tags: ['autodocs'],
} satisfies Meta<typeof UpsellGrid>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Added: Story = { args: { addedIds: ['toast'] } };
