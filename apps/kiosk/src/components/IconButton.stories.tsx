import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { Wrapper } from './Wrapper';
import { IconButton } from './IconButton';
const meta = {
  title: 'Kiosk/IconButton',
  component: IconButton,
  decorators: [
    (Story) => (
      <Wrapper padding={28}>
        <Story />
      </Wrapper>
    ),
  ],
  args: { name: 'add', label: 'Добавить блюдо', onPress: fn(), tone: 'accent' },
  tags: ['autodocs'],
} satisfies Meta<typeof IconButton>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Disabled = { args: { disabled: true } };
/** Disabled for assistive tech, but a tap still reaches `onRefused` (feedback). */
export const Refused = { args: { disabled: true, onRefused: fn() } };
