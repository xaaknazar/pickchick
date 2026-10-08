import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { line } from '../stories/fixtures';
import { Wrapper } from './Wrapper';
import { CheckoutSummary } from './CheckoutSummary';
import { colors } from '../theme';
const meta = {
  title: 'Kiosk/CheckoutSummary',
  component: CheckoutSummary,
  decorators: [
    (Story) => (
      // Backdrop only: the summary card sits on the blue v3 review screen.
      <View style={{ flex: 1, backgroundColor: colors.blue }}>
        <Wrapper padding={28}>
          <Story />
        </Wrapper>
      </View>
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
