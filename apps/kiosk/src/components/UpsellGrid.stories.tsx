import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { catalog } from '../stories/fixtures';
import { UpsellGrid } from './UpsellGrid';
const meta = {
  title: 'Kiosk/UpsellGrid',
  component: UpsellGrid,
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
