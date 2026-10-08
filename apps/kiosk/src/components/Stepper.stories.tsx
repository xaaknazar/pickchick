import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { fn } from 'storybook/test';
import { colors } from '../theme';
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
/** + at the maximum calls `onLimit` (the extras row shakes). */
export const AtLimit = { args: { quantity: 20, onLimit: fn() } };
export const Busy = { args: { disabled: true } };
export const CustomIds = {
  args: {
    prefix: undefined,
    ids: { minus: 'story-minus', quantity: 'story-quantity', plus: 'story-plus' },
    labels: { minus: '- Тост', plus: '+ Тост' },
  },
};
export const OnBlue: Story = {
  args: { tone: 'onBlue' },
  decorators: [
    (Story) => (
      // Backdrop only.
      <View style={{ backgroundColor: colors.blue, padding: 28 }}>
        <Story />
      </View>
    ),
  ],
};
