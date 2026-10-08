import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { fn } from 'storybook/test';
import { defaultSelections } from '../cart';
import { catalog, group, selections } from '../stories/fixtures';
import { colors } from '../theme';
import { ModifierOptions } from './ProductOptions';
const duo = catalog.products.find((p) => p.id === 'finger-duo')!;
const set = catalog.products.find((p) => p.id === 'fingers-25')!;
const sauceSizes = catalog.products.find((p) => p.id === 'sauce')!;
const pick = catalog.products.find((p) => p.id === 'pick-combo')!;
const meta = {
  title: 'Kiosk/ModifierOptions',
  component: ModifierOptions,
  decorators: [
    (Story) => (
      // Backdrop only: v3 option groups sit on the blue product page.
      <View style={{ backgroundColor: colors.blue, padding: 36 }}>
        <Story />
      </View>
    ),
  ],
  args: { group, selections, setSelections: fn(), locale: 'ru' },
  tags: ['autodocs'],
} satisfies Meta<typeof ModifierOptions>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Sauces = { args: { group: pick.modifier_groups[1]! } };
export const Extras = {
  args: {
    group: pick.modifier_groups[2]!,
    selections: [...selections, { group_id: 'extras', option_id: 'toast', quantity: 2 }],
  },
};
export const DuoDrinksIncomplete = {
  args: { group: duo.modifier_groups[0]!, selections: [] },
};
export const SetSauces = {
  args: { group: set.modifier_groups[0]!, selections: defaultSelections(set) },
};
export const Sizes = {
  args: { group: sauceSizes.modifier_groups[0]!, selections: defaultSelections(sauceSizes) },
};
export const Kazakh = { args: { locale: 'kk' } };
