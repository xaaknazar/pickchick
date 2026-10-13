import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { product, selections } from '../stories/fixtures';
import { ComboOptionSheet } from './ComboOptionSheet';
const meta = {
  title: 'Kiosk/Redesign/ComboOptionSheet',
  component: ComboOptionSheet,
  args: {
    visible: true,
    group: product.modifier_groups[0]!,
    productName: product.name,
    selections,
    setSelections: fn(),
    included: 'Входит в комбо',
    locale: 'ru',
    onClose: fn(),
  },
  tags: ['autodocs'],
} satisfies Meta<typeof ComboOptionSheet>;
export default meta;
type Story = StoryObj<typeof meta>;
/** Drinks on their shelves; Coca-Cola picked. */
export const Drinks: Story = {};
/** Lemonade picked: «Готово · Лимонад 0.5 л +200 ₸». */
export const Lemonade: Story = {
  args: {
    selections: [
      { group_id: 'drink', option_id: 'lemonade', quantity: 1 },
      { group_id: 'sauce', option_id: 'pick', quantity: 1 },
    ],
  },
};
export const Kazakh: Story = { args: { locale: 'kk' } };
