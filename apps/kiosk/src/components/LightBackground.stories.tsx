import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { LightBackground } from './PatternBackground';
const meta = {
  title: 'Kiosk/LightBackground',
  component: LightBackground,
  args: {},
  tags: ['autodocs'],
} satisfies Meta<typeof LightBackground>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
