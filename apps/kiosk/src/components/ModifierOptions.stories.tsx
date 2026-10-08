import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { fn } from 'storybook/test';
import { defaultSelections, selectedPriceMinor, testLineId } from '../cart';
import { catalog, group, selections } from '../stories/fixtures';
import { colors } from '../theme';
import { ModifierOptions } from './ProductOptions';
const duo = catalog.products.find((p) => p.id === 'finger-duo')!;
const set = catalog.products.find((p) => p.id === 'fingers-25')!;
const sauceSizes = catalog.products.find((p) => p.id === 'sauce')!;
const pick = catalog.products.find((p) => p.id === 'pick-combo')!;
import { useState } from 'react';
import { Wrapper } from './Wrapper';
import { CartRow } from './CartRow';
import { mockupCatalogDraft } from '../../../../packages/catalog-admin/src/seed';
import { withPikoFlavors } from '../../../../packages/catalog-admin/src/piko-flavors';
import { publishedKioskCatalog } from '../commercial-controller';
const prepared = publishedKioskCatalog({
  branch: { id: '00000000-0000-4000-8000-000000000001' },
  channel: 'kiosk',
  version: 4,
  payload: withPikoFlavors(mockupCatalogDraft),
});
const piko = prepared.products.find((product) => product.id === 'piko')!;
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
/** The guest tapped "to cart" with this choice missing: the options shake. */
export const Attention = {
  args: { group: duo.modifier_groups[0]!, selections: [], attention: 1 },
};
/** Live picks: tiles pulse, checks pop, rings fade; a pick past the limit shakes. */
export const Live: Story = {
  args: { group: pick.modifier_groups[1]! },
  render: function LiveStory(args) {
    const [choices, setChoices] = useState(args.selections);
    return (
      <ModifierOptions
        group={args.group}
        locale={args.locale}
        selections={choices}
        setSelections={setChoices}
      />
    );
  },
};

export const PikoFlavors: Story = {
  args: { group: piko.modifier_groups[0]!, selections: defaultSelections(piko) },
  render: function PikoFlavorStory(args) {
    const [choices, setChoices] = useState(args.selections);
    const price = selectedPriceMinor(piko, choices);
    return (
      <Wrapper gap={28}>
        <ModifierOptions
          group={args.group}
          locale={args.locale}
          selections={choices}
          setSelections={setChoices}
        />
        <CartRow
          line={{
            lineId: testLineId(piko.id, choices),
            productId: piko.id,
            product: piko,
            quantity: 1,
            selections: choices,
            unitPriceMinor: price,
            lineTotalMinor: price,
          }}
          locale={args.locale}
          busy={false}
          onQuantity={fn()}
        />
      </Wrapper>
    );
  },
};
export const ComboWithPikoFlavors: Story = {
  args: { group: prepared.products[0]!.modifier_groups[0]! },
};
