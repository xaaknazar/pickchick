import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { catalog, memory } from '../stories/fixtures';
import { MenuGrid } from './MenuGrid';
const meta = {
  title: 'Kiosk/MenuGrid',
  component: MenuGrid,
  args: {
    products: catalog.products.filter((p) => p.category === 'Комбо'),
    category: 'combo',
    memory,
    locale: 'ru',
    busy: false,
    onOpen: fn(),
    onAdd: fn(),
    onInteraction: fn(),
  },
  tags: ['autodocs'],
} satisfies Meta<typeof MenuGrid>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
