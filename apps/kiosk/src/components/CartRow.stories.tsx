import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { line } from '../stories/fixtures';
import { Wrapper } from './Wrapper';
import { CartRow } from './CartRow';
const meta = {
  title: 'Kiosk/CartRow',
  component: CartRow,
  decorators: [
    (Story) => (
      <Wrapper padding={28}>
        <Story />
      </Wrapper>
    ),
  ],
  args: { line, locale: 'ru', busy: false, onQuantity: fn() },
  tags: ['autodocs'],
} satisfies Meta<typeof CartRow>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const LongModifiers = { args: { line: { ...line, quantity: 20 } } };
