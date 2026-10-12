import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { fn } from 'storybook/test';
import { redesign } from '../theme';
import { catalog, line } from '../stories/fixtures';
import type { KioskCartLine } from '../model';
import { CartBar } from './CartBar';
const cola = catalog.products.find((p) => p.id === 'cola')!;
const colaLine: KioskCartLine = {
  lineId: 'story-cola',
  productId: cola.id,
  quantity: 1,
  selections: [],
  product: cola,
  unitPriceMinor: cola.price_minor,
  lineTotalMinor: cola.price_minor,
};
const meta = {
  title: 'Kiosk/CartBar',
  component: CartBar,
  decorators: [
    (Story) => (
      // Backdrop only: the checkout panel floats over the bottom of the blue menu.
      <View style={{ height: 320, backgroundColor: redesign.screen[1] }}>
        <Story />
      </View>
    ),
  ],
  args: {
    lines: [line, colaLine],
    quantity: 2,
    total: '518000',
    valid: true,
    empty: false,
    busy: false,
    locale: 'ru',
    onCheckout: fn(),
    onOpenCart: fn(),
  },
  tags: ['autodocs'],
} satisfies Meta<typeof CartBar>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
/** Empty cart: no photos, the hint, and a disabled checkout. */
export const Empty: Story = { args: { lines: [], quantity: 0, total: '0', empty: true } };
export const Invalid: Story = { args: { valid: false } };
export const Busy: Story = { args: { busy: true } };
export const Kazakh: Story = { args: { locale: 'kk' } };
export const Added: Story = { args: { previousQuantity: 1, quantity: 2 } };
/** Total counts up from the previous amount (380 ms). */
export const TotalTween: Story = { args: { previousTotal: '419000' } };
/** The photo of the line just added arcs onto the cart photos, which bump as it lands. */
export const Arrival: Story = {
  args: {
    previousQuantity: 1,
    arrival: { product: cola, selections: [] },
    onLanded: fn(),
  },
};
