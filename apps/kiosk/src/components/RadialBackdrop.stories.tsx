import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { ScreenSurface } from './ScreenSurface';
import { RadialBackdrop } from './RadialBackdrop';
const meta = {
  title: 'Kiosk/Redesign/RadialBackdrop',
  component: RadialBackdrop,
  decorators: [
    (Story) => (
      <ScreenSurface tone="brand">
        <Story />
      </ScreenSurface>
    ),
  ],
  tags: ['autodocs'],
} satisfies Meta<typeof RadialBackdrop>;
export default meta;
type Story = StoryObj<typeof meta>;
/** The redesign screen background: a glow from the top right into the deep brand blue. */
export const Default: Story = {};
