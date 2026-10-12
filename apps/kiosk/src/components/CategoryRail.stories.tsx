import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { fn } from 'storybook/test';
import { redesign } from '../theme';
import { catalog } from '../stories/fixtures';
import { CategoryRail } from './CategoryRail';
const meta = {
  title: 'Kiosk/CategoryRail',
  component: CategoryRail,
  decorators: [
    (Story) => (
      // Backdrop only: the rail sits on the redesigned blue menu surface.
      <View style={{ height: 1238, backgroundColor: redesign.screen[1] }}>
        <Story />
      </View>
    ),
  ],
  args: { category: 'combo', products: catalog.products, locale: 'ru', onSelect: fn() },
  tags: ['autodocs'],
} satisfies Meta<typeof CategoryRail>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Extras: Story = { args: { category: 'extras' } };
export const Drinks: Story = { args: { category: 'drinks' } };
export const Kazakh = { args: { locale: 'kk' } };
/** A short (landscape) screen: tiles shrink to 104 pt, then the rail scrolls. */
export const Short: Story = {
  decorators: [
    (Inner) => (
      <View style={{ height: 760, backgroundColor: redesign.screen[1] }}>
        <Inner />
      </View>
    ),
  ],
};
