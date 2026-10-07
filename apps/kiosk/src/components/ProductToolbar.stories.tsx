import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { ProductToolbar } from './ProductToolbar';
const meta = {
  title: 'Kiosk/ProductToolbar',
  component: ProductToolbar,
  args: { locale: 'ru', onClose: fn() },
  tags: ['autodocs'],
} satisfies Meta<typeof ProductToolbar>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const SetWizard = { args: { step: 1, steps: 2 } };
