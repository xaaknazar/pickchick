import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { group, selections } from '../stories/fixtures';
import { Wrapper } from './Wrapper';
import { ModifierOptions } from './ProductOptions';
import { useState } from 'react';
import { mockupCatalogDraft } from '../../../../packages/catalog-admin/src/seed';
import { withPikoFlavors } from '../../../../packages/catalog-admin/src/piko-flavors';
import { publishedKioskCatalog } from '../commercial-controller';
import { defaultSelections, selectedPriceMinor, testLineId } from '../cart';
import { CartRow } from './CartRow';
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
      <Wrapper padding={28}>
        <Story />
      </Wrapper>
    ),
  ],
  args: { group, selections, setSelections: fn(), locale: 'ru' },
  tags: ['autodocs'],
} satisfies Meta<typeof ModifierOptions>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
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
