import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { fn } from 'storybook/test';
import { redesign } from '../theme';
import { ComboPanel } from './ComboPanel';
const meta = {
  title: 'Kiosk/Redesign/ComboPanel',
  component: ComboPanel,
  decorators: [
    (Story) => (
      // Backdrop only: the panel floats over the bottom of the blue product card.
      <View style={{ height: 320, backgroundColor: redesign.screen[1] }}>
        <Story />
      </View>
    ),
  ],
  args: {
    locale: 'ru',
    quantity: 1,
    price: '419000',
    valid: true,
    available: true,
    busy: false,
    summary: 'Coca-Cola 0.5 л · Фирменный соус',
    status: 'Всё выбрано',
    onMinus: fn(),
    onPlus: fn(),
    onAdd: fn(),
    onAttention: fn(),
  },
  tags: ['autodocs'],
} satisfies Meta<typeof ComboPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
/** A sauce is missing: the pale, disabled button. */
export const Missing: Story = {
  args: { price: null, valid: false, summary: 'Coca-Cola 0.5 л', status: 'Выберите соус' },
};
/** Two lemonade combos: the price with the surcharge and the quantity. */
export const Two: Story = {
  args: { quantity: 2, price: '878000', summary: 'Лимонад 0.5 л · Фирменный соус' },
};
export const Limit: Story = { args: { limit: 'Больше 20 одинаковых позиций добавить нельзя' } };
export const Busy: Story = { args: { busy: true } };
export const English: Story = { args: { locale: 'en', status: 'All set' } };
