import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { catalog } from '../stories/fixtures';
import { CategoryRail } from './CategoryRail';
const meta = {
  title: 'Kiosk/CategoryRail',
  component: CategoryRail,
  args: { category: 'combo', products: catalog.products, locale: 'ru', onSelect: fn() },
  tags: ['autodocs'],
} satisfies Meta<typeof CategoryRail>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Kazakh = { args: { locale: 'kk' } };
