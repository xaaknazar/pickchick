import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { ScreenSurface } from './ScreenSurface';
import { Hero } from './Hero';
const meta = {
  title: 'Kiosk/Hero',
  component: Hero,
  decorators: [
    (Story) => (
      <ScreenSurface tone="brand">
        <Story />
      </ScreenSurface>
    ),
  ],
  args: { video: false },
  tags: ['autodocs'],
} satisfies Meta<typeof Hero>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Motion = { args: { video: true } };
