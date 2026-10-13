import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { ScreenSurface } from './ScreenSurface';
import { RadialBackdrop } from './RadialBackdrop';
import { StarField } from './StarField';
const meta = {
  title: 'Kiosk/Redesign/StarField',
  component: StarField,
  decorators: [
    (Story) => (
      <ScreenSurface tone="brand">
        <RadialBackdrop />
        <Story />
      </ScreenSurface>
    ),
  ],
  tags: ['autodocs'],
} satisfies Meta<typeof StarField>;
export default meta;
type Story = StoryObj<typeof meta>;
/** Kaspi QR sky: still stars and dots over the redesign gradient, hidden from VoiceOver. */
export const Default: Story = {};
