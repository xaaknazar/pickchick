import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { ScreenSurface } from './ScreenSurface';
import { DiningModeTitle } from './DiningModeCard';
const meta = {
  title: 'Kiosk/DiningModeTitle',
  component: DiningModeTitle,
  decorators: [
    (Story) => (
      <ScreenSurface tone="night">
        <Story />
      </ScreenSurface>
    ),
  ],
  args: { children: 'Как будете есть?' },
  tags: ['autodocs'],
} satisfies Meta<typeof DiningModeTitle>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Kazakh = { args: { children: 'Қалай тамақтанасыз?' } };
