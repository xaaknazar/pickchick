import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { ScreenSurface } from './ScreenSurface';
import { RadialBackdrop } from './RadialBackdrop';
import { Wrapper } from './Wrapper';
import { QrTimer } from './QrTimer';
const meta = {
  title: 'Kiosk/Redesign/QrTimer',
  component: QrTimer,
  decorators: [
    (Story) => (
      <ScreenSurface tone="brand">
        <RadialBackdrop />
        <Wrapper flex={1} align="center" justify="center">
          <Story />
        </Wrapper>
      </ScreenSurface>
    ),
  ],
  args: { expiresAt: new Date(Date.now() + 178000).toISOString(), locale: 'ru' },
  tags: ['autodocs'],
} satisfies Meta<typeof QrTimer>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
/** Half of the lifetime is gone. */
export const Half: Story = { args: { expiresAt: new Date(Date.now() + 90000).toISOString() } };
export const AlmostOver: Story = {
  args: { expiresAt: new Date(Date.now() + 20000).toISOString() },
};
export const Kazakh: Story = { args: { locale: 'kk' } };
export const English: Story = { args: { locale: 'en' } };
