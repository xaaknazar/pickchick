import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { fn } from 'storybook/test';
import { colors } from '../theme';
import { catalog } from '../stories/fixtures';
import { CategoryRail } from './CategoryRail';
const meta = {
  title: 'Kiosk/CategoryRail',
  component: CategoryRail,
  decorators: [
    (Story) => (
      // Backdrop only: the rail sits on the blue v3 menu surface.
      <View style={{ height: 760, backgroundColor: colors.blue }}>
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
export const Kazakh = { args: { locale: 'kk' } };
