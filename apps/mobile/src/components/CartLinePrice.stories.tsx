import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { CartLinePrice } from './CartLinePrice';
const meta = {
  title: 'Mobile/CartLinePrice',
  component: CartLinePrice,
  tags: ['autodocs'],
  args: { unitMinor: '449000', previousUnitMinor: '419000', quantity: 2 },
} satisfies Meta<typeof CartLinePrice>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Updated: Story = {};
export const Unchanged: Story = { args: { previousUnitMinor: undefined } };
