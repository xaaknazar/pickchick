import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { fn } from 'storybook/test';
import { defaultSelections } from '../cart';
import { catalog, product, selections } from '../stories/fixtures';
import { redesign } from '../theme';
import { ComboSection } from './ComboSection';
const duo = catalog.products.find((p) => p.id === 'finger-duo')!;
const meta = {
  title: 'Kiosk/Redesign/ComboSection',
  component: ComboSection,
  decorators: [
    (Story) => (
      // Backdrop only: a section of the blue product card.
      <View style={{ backgroundColor: redesign.screen[1], padding: 16, width: 1024 }}>
        <Story />
      </View>
    ),
  ],
  args: {
    number: 1,
    group: product.modifier_groups[0]!,
    selections,
    setSelections: fn(),
    included: 'Входит в комбо',
    locale: 'ru',
    onMore: fn(),
  },
  tags: ['autodocs'],
} satisfies Meta<typeof ComboSection>;
export default meta;
type Story = StoryObj<typeof meta>;
/** Fourteen drinks: nine tiles and «Ещё 5 · Показать все». */
export const Drinks: Story = {};
/** Lemonade picked: the green pill shows the surcharge. */
export const Lemonade: Story = {
  args: {
    selections: [
      { group_id: 'drink', option_id: 'lemonade', quantity: 1 },
      { group_id: 'sauce', option_id: 'pick', quantity: 1 },
    ],
  },
};
/** A drink from the sheet takes the last tile. */
export const PickedFromSheet: Story = {
  args: { selections: [{ group_id: 'drink', option_id: 'piko', quantity: 1 }] },
};
export const Sauces: Story = { args: { number: 2, group: product.modifier_groups[1]! } };
/** Nothing picked: the peach «Выберите соус». */
export const Empty: Story = {
  args: { number: 2, group: product.modifier_groups[1]!, selections: [] },
};
/** Duo: two sauces, counted on the tiles. */
export const DuoSauces: Story = {
  args: { number: 2, group: duo.modifier_groups[1]!, selections: defaultSelections(duo) },
};
