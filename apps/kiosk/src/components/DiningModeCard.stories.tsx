import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { Wrapper } from './Wrapper';
import { DiningModeCard } from './DiningModeCard';
const meta = {
  title: 'Kiosk/DiningModeCard',
  component: DiningModeCard,
  decorators: [
    (Story) => (
      <Wrapper padding={28}>
        <Story />
      </Wrapper>
    ),
  ],
  args: { mode: 'dine_in', locale: 'ru', busy: false, onSelect: fn() },
  tags: ['autodocs'],
} satisfies Meta<typeof DiningModeCard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Takeaway = { args: { mode: 'takeaway' } };
