import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { fn } from 'storybook/test';
import { colors } from '../theme';
import { catalog, memory } from '../stories/fixtures';
import { MenuGrid } from './MenuGrid';
const meta = {
  title: 'Kiosk/MenuGrid',
  component: MenuGrid,
  decorators: [
    (Story) => (
      // Backdrop only: the menu feed lives on the blue v3 surface.
      <View style={{ height: 1100, backgroundColor: colors.blue }}>
        <Story />
      </View>
    ),
  ],
  args: {
    products: catalog.products.filter((p) => p.category === 'Комбо'),
    category: 'combo',
    memory,
    locale: 'ru',
    busy: false,
    featured: catalog.products.find((p) => p.name === 'Master Combo') ?? null,
    onOpen: fn(),
    onAdd: fn(),
    onInteraction: fn(),
  },
  tags: ['autodocs'],
} satisfies Meta<typeof MenuGrid>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const WithoutBillboard: Story = { args: { featured: null } };
