import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { BluePattern } from './PatternBackground';
const meta = {
  title: 'Kiosk/BluePattern',
  component: BluePattern,
  args: {},
  tags: ['autodocs'],
} satisfies Meta<typeof BluePattern>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
