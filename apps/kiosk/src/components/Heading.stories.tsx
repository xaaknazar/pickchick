import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { Wrapper } from './Wrapper';
import { Heading } from './Heading';
const meta = {
  title: 'Kiosk/Heading',
  component: Heading,
  decorators: [
    (Story) => (
      <Wrapper padding={28}>
        <Story />
      </Wrapper>
    ),
  ],
  args: { children: 'Соберите своё комбо' },
  tags: ['autodocs'],
} satisfies Meta<typeof Heading>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Card = { args: { size: 'card' } };
export const Display = { args: { size: 'display' } };
