import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { fn } from 'storybook/test';
import { redesign } from '../theme';
import { catalog, memory } from '../stories/fixtures';
import { MenuGrid } from './MenuGrid';
const section = (category: string) => catalog.products.filter((p) => p.category === category);
const meta = {
  title: 'Kiosk/MenuGrid',
  component: MenuGrid,
  decorators: [
    (Story) => (
      // Backdrop only: the bento grid lives on the redesigned blue menu.
      <View style={{ width: 822, height: 1238, backgroundColor: redesign.screen[1] }}>
        <Story />
      </View>
    ),
  ],
  args: {
    products: section('Комбо'),
    category: 'combo',
    memory,
    locale: 'ru',
    busy: false,
    onOpen: fn(),
    onAdd: fn(),
    onInteraction: fn(),
  },
  tags: ['autodocs'],
} satisfies Meta<typeof MenuGrid>;
export default meta;
type Story = StoryObj<typeof meta>;
/** Four products: a tall card on the left, two on the right. */
export const Combo: Story = {};
/** Three products: two tall cards under the hit. */
export const Duo: Story = { args: { products: section('На двоих'), category: 'duo' } };
/** Seven products: two full rows of three. */
export const Extras: Story = { args: { products: section('Допы'), category: 'extras' } };
/** Six products: the last card stretches over two columns. */
export const Drinks: Story = { args: { products: section('Напитки'), category: 'drinks' } };
/** Nineteen drinks: rows keep their minimum height and the section scrolls. */
export const ManyDrinks: Story = {
  args: {
    category: 'drinks',
    products: Array.from({ length: 19 }, (_, i) => {
      const drinks = section('Напитки');
      const base = drinks[i % drinks.length]!;
      return i < drinks.length ? base : { ...base, id: `${base.id}-${i}` };
    }),
  },
};
export const WithCart: Story = { args: { cartCounts: { 'pick-combo': 2, 'master-combo': 1 } } };
export const Kazakh: Story = { args: { locale: 'kk' } };
