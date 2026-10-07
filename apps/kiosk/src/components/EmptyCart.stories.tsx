import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { EmptyCart } from './EmptyCart';
const meta = {
  title: 'Kiosk/EmptyCart',
  component: EmptyCart,
  args: { locale: 'ru' },
  tags: ['autodocs'],
} satisfies Meta<typeof EmptyCart>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
