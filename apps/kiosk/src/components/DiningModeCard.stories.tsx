import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { ScreenSurface } from './ScreenSurface';
import { Wrapper } from './Wrapper';
import { DiningModeCard } from './DiningModeCard';
const meta = {
  title: 'Kiosk/DiningModeCard',
  component: DiningModeCard,
  decorators: [
    (Story) => (
      <ScreenSurface tone="night">
        <Wrapper flex={1} padding={40}>
          <Story />
        </Wrapper>
      </ScreenSurface>
    ),
  ],
  args: { mode: 'dine_in', locale: 'ru', busy: false, onSelect: fn() },
  tags: ['autodocs'],
} satisfies Meta<typeof DiningModeCard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Takeaway = { args: { mode: 'takeaway' } };
export const Kazakh = { args: { locale: 'kk' } };
export const Busy = { args: { busy: true } };
