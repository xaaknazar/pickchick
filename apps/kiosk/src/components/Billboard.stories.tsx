import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { fn } from 'storybook/test';
import { catalog } from '../stories/fixtures';
import { Billboard } from './Billboard';
const find = (id: string) => catalog.products.find((p) => p.id === id) ?? catalog.products[0]!;
const meta = {
  title: 'Kiosk/Billboard',
  component: Billboard,
  decorators: [
    (Story) => (
      // Frame only: the menu grid gives the hit tile its full-width row.
      <View style={{ width: 806, height: 350, padding: 0 }}>
        <Story />
      </View>
    ),
  ],
  args: {
    product: find('master-combo'),
    label: 'ХИТ НЕДЕЛИ',
    locale: 'ru',
    onOpen: fn(),
    onAdd: fn(),
  },
  tags: ['autodocs'],
} satisfies Meta<typeof Billboard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const MasterCombo: Story = {};
export const Lemonade: Story = { args: { product: find('lemonade'), label: 'ФИРМЕННЫЙ' } };
export const Kazakh: Story = { args: { locale: 'kk', label: 'АПТА ХИТІ' } };
export const InBag: Story = { args: { inCart: 2 } };
export const SoldOut: Story = {
  args: { product: { ...find('burger'), available: false }, label: 'ЛЮБИМЫЙ ДОП' },
};
