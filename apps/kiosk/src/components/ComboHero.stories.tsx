import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { fn } from 'storybook/test';
import { catalog, product } from '../stories/fixtures';
import { redesign } from '../theme';
import { ComboHero } from './ComboHero';
const find = (id: string) => catalog.products.find((p) => p.id === id)!;
const meta = {
  title: 'Kiosk/Redesign/ComboHero',
  component: ComboHero,
  decorators: [
    (Story) => (
      // Backdrop only: the hero sits 16 pt from the sides of the blue product card.
      <View style={{ backgroundColor: redesign.screen[1], padding: 16 }}>
        <Story />
      </View>
    ),
  ],
  args: { product, locale: 'ru', onDetails: fn() },
  tags: ['autodocs'],
} satisfies Meta<typeof ComboHero>;
export default meta;
type Story = StoryObj<typeof meta>;
/** Pick Combo: «ХИТ НЕДЕЛИ», six composition pills, «520 г · 1240 ккал». */
export const Default: Story = {};
/** A duo with longer pills that wrap to a third row. */
export const Duo: Story = { args: { product: find('finger-duo') } };
/** Prose description: the text instead of pills. */
export const Description: Story = { args: { product: find('burger-duo') } };
export const English: Story = { args: { locale: 'en', product: find('master-combo') } };
export const PikoOrange: Story = {
  args: {
    product: find('piko'),
    selections: [{ group_id: 'piko-flavor', option_id: 'piko-orange', quantity: 1 }],
  },
};
