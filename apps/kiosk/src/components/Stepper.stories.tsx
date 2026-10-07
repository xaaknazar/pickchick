import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { Wrapper } from './Wrapper';
import { Stepper } from './Stepper';
const meta = {
  title: 'Kiosk/Stepper',
  component: Stepper,
  decorators: [
    (Story) => (
      <Wrapper padding={28}>
        <Story />
      </Wrapper>
    ),
  ],
  args: { quantity: 1, min: 0, max: 20, prefix: 'story-stepper', onPlus: fn(), onMinus: fn() },
  tags: ['autodocs'],
} satisfies Meta<typeof Stepper>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Empty = { args: { quantity: 0 } };
export const Maximum = { args: { quantity: 20 } };
export const Busy = { args: { disabled: true } };
