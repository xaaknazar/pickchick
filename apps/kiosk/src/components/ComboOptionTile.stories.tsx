import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { fn } from 'storybook/test';
import { product } from '../stories/fixtures';
import { redesign } from '../theme';
import { ComboOptionTile } from './ComboOptionTile';
const drinks = product.modifier_groups[0]!;
const sauces = product.modifier_groups[1]!;
const option = (group: typeof drinks, id: string) => group.options.find((o) => o.id === id)!;
const meta = {
  title: 'Kiosk/Redesign/ComboOptionTile',
  component: ComboOptionTile,
  decorators: [
    (Story) => (
      // Backdrop only: one tile of the five-column drinks grid on the blue card.
      <View style={{ backgroundColor: redesign.screen[1], padding: 24, width: 236 }}>
        <View style={{ flexDirection: 'row' }}>
          <Story />
        </View>
      </View>
    ),
  ],
  args: {
    groupId: drinks.id,
    option: option(drinks, 'cola-bottle'),
    quantity: 1,
    multi: false,
    full: false,
    clearable: false,
    included: 'Входит в комбо',
    tall: true,
    locale: 'ru',
    onChange: fn(),
  },
  tags: ['autodocs'],
} satisfies Meta<typeof ComboOptionTile>;
export default meta;
type Story = StoryObj<typeof meta>;
/** Picked: the orange ring and check. */
export const Selected: Story = {};
/** A surcharge pill «+200 ₸». */
export const Surcharge: Story = { args: { option: option(drinks, 'lemonade'), quantity: 0 } };
/** Stopped: the tile at .5, not pressable. */
export const SoldOut: Story = { args: { option: option(drinks, 'fuse-watermelon'), quantity: 0 } };
/** No photo: the Heinz colour disc. */
export const Heinz: Story = {
  args: { groupId: sauces.id, option: option(sauces, 'cheese'), quantity: 0, tall: false },
};
/** Several picks in the group: the count and the minus disc. */
export const Counted: Story = {
  args: {
    groupId: sauces.id,
    option: option(sauces, 'pick'),
    quantity: 2,
    multi: true,
    tall: false,
  },
};
