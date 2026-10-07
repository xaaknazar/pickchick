import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { Wrapper } from './Wrapper';
import { Logo } from './Logo';
const meta = {
  title: 'Kiosk/Logo',
  component: Logo,
  decorators: [
    (Story) => (
      <Wrapper padding={28}>
        <Story />
      </Wrapper>
    ),
  ],
  args: {},
  tags: ['autodocs'],
} satisfies Meta<typeof Logo>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const HeroSize = { args: { size: 'hero' } };
