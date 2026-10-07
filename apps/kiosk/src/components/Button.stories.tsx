import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { Wrapper } from './Wrapper';
import { Button } from './Button';
const meta = {
  title: 'Kiosk/Button',
  component: Button,
  decorators: [
    (Story) => (
      <Wrapper padding={28}>
        <Story />
      </Wrapper>
    ),
  ],
  args: { label: 'В корзину · 2 990 ₸', onPress: fn() },
  tags: ['autodocs'],
} satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Disabled = { args: { disabled: true } };
export const Loading = { args: { busy: true } };
export const Secondary = { args: { tone: 'secondary' } };
export const Primary = { args: { tone: 'primary' } };
export const Compact = { args: { size: 'compact' } };
