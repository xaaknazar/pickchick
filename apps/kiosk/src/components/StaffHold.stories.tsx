import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { ScreenSurface } from './ScreenSurface';
import { Wrapper } from './Wrapper';
import { Icon } from './Icon';
import { StaffHold } from './StaffHold';
const meta = {
  title: 'Kiosk/StaffHold',
  component: StaffHold,
  decorators: [
    (Story) => (
      <ScreenSurface tone="brand">
        <Wrapper padding={28} align="center">
          <Story />
        </Wrapper>
      </ScreenSurface>
    ),
  ],
  args: {
    onHold: fn(),
    children: <Icon name="time-outline" size="hero" tone="inverse" />,
  },
  tags: ['autodocs'],
} satisfies Meta<typeof StaffHold>;
export default meta;
type Story = StoryObj<typeof meta>;
/** A five-second hold on the mark opens the staff dialog; guests see only the mark. */
export const Default: Story = {};
/** Without a handler the mark is plain. */
export const Plain: Story = { args: { onHold: undefined } };
