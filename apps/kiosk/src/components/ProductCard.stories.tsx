import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { fn } from 'storybook/test';
import { catalog, product } from '../stories/fixtures';
import { ProductCard } from './ProductCard';
const find = (id: string) => catalog.products.find((p) => p.id === id) ?? product;
const meta = {
  title: 'Kiosk/ProductCard',
  component: ProductCard,
  decorators: [
    (Story) => (
      // Frame only: the bento grid sizes every card.
      <View style={{ width: 395, height: 533, padding: 0 }}>
        <Story />
      </View>
    ),
  ],
  args: { product, locale: 'ru', onOpen: fn(), onAdd: fn() },
  tags: ['autodocs'],
} satisfies Meta<typeof ProductCard>;
export default meta;
type Story = StoryObj<typeof meta>;
/** Tall two-column card (`large`) with description and the «ХИТ» badge. */
export const Default: Story = { args: { badge: 'hit' } };
export const Medium: Story = {
  args: { product: find('solo-combo'), size: 'medium', badge: 'new', index: 2 },
};
export const Small: Story = {
  args: { product: find('sauce-hot'), size: 'small', badge: 'spicy', index: 3 },
  decorators: [
    (Inner) => (
      <View style={{ width: 258, height: 368 }}>
        <Inner />
      </View>
    ),
  ],
};
/** The last card of a row with free cells: photo left 58 %, text right. */
export const Wide: Story = {
  args: { product: find('piko'), size: 'wide', index: 1 },
  decorators: [
    (Inner) => (
      <View style={{ width: 532, height: 368 }}>
        <Inner />
      </View>
    ),
  ],
};
export const Kazakh: Story = { args: { locale: 'kk', badge: 'new' } };
export const SoldOut = { args: { product: { ...product, available: false } } };
export const Loading = { args: { busy: true } };
/** Blue count badge: two of this product are already in the bag. */
export const InBag: Story = { args: { inCart: 2 } };
/** The badge stays hidden while the photo is still flying into the bag. */
export const Arriving: Story = { args: { inCart: 1, arriving: true } };
