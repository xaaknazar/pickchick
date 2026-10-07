import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { ScreenSurface } from './ScreenSurface';
import { HeroShade } from './HeroBackdrop';
const meta = {
  title: 'Kiosk/HeroShade',
  component: HeroShade,
  decorators: [
    (Story) => (
      <ScreenSurface tone="brand">
        <Story />
      </ScreenSurface>
    ),
  ],
  args: {},
  tags: ['autodocs'],
} satisfies Meta<typeof HeroShade>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
