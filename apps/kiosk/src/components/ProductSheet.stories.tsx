import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { catalog } from '../stories/fixtures';
import { sheetLineId } from '../productSheet';
import { ScreenSurface } from './ScreenSurface';
import { ProductSheet } from './ProductSheet';
const product = (id: string) => catalog.products.find((p) => p.id === id)!;
const meta = {
  title: 'Kiosk/Redesign/ProductSheet',
  component: ProductSheet,
  decorators: [
    (Story) => (
      <ScreenSurface tone="redesign">
        <Story />
      </ScreenSurface>
    ),
  ],
  args: {
    product: product('sauce'),
    locale: 'ru',
    busy: false,
    cart: [],
    lineCount: 0,
    onAdd: fn(),
    onClose: fn(),
    onInteraction: fn(),
  },
  tags: ['autodocs'],
} satisfies Meta<typeof ProductSheet>;
export default meta;
type Story = StoryObj<typeof meta>;
/** Signature sauce: four size tiles, the default 60 мл chosen (product-sauce-sheet.webp). */
export const SauceWithSize: Story = {};
/** A product without any choice: photo, texts, quantity and the add button (product-simple-sheet.webp). */
export const Toast: Story = { args: { product: product('toast') } };
export const Drink: Story = { args: { product: product('lemonade') } };
export const Kazakh: Story = { args: { locale: 'kk' } };
export const English: Story = { args: { locale: 'en', product: product('toast') } };
/** 20 of this line are already in the cart: the button says why it cannot add. */
export const LineFull: Story = {
  args: {
    cart: [{ lineId: sheetLineId(product('sauce'), 'size-0'), quantity: 20 }],
    lineCount: 1,
  },
};
/** The cart already holds 11 different lines. */
export const CartFull: Story = { args: { product: product('toast'), lineCount: 11 } };
export const SoldOut: Story = {
  args: { product: { ...product('toast'), available: false } },
};
export const Busy: Story = { args: { busy: true } };
