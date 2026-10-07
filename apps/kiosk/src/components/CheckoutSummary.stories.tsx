import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { line } from '../stories/fixtures';
import { Wrapper } from './Wrapper';
import { CheckoutSummary } from './CheckoutSummary';
const meta = {
  title: 'Kiosk/CheckoutSummary',
  component: CheckoutSummary,
  decorators: [
    (Story) => (
      <Wrapper padding={28}>
        <Story />
      </Wrapper>
    ),
  ],
  args: {
    lines: [line],
    total: line.lineTotalMinor,
    valid: true,
    locale: 'ru',
    estimated: { min: 10, max: 15 },
  },
  tags: ['autodocs'],
} satisfies Meta<typeof CheckoutSummary>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
