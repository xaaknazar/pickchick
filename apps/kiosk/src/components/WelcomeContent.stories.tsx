import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { ScreenSurface } from './ScreenSurface';
import { WelcomeContent } from './WelcomeContent';
const meta = {
  title: 'Kiosk/WelcomeContent',
  component: WelcomeContent,
  decorators: [
    (Story) => (
      <ScreenSurface tone="brand">
        <Story />
      </ScreenSurface>
    ),
  ],
  args: { locale: 'ru', onLocale: fn(), onStart: fn(), busy: false },
  tags: ['autodocs'],
} satisfies Meta<typeof WelcomeContent>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
