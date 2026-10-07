import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { Wrapper } from './Wrapper';
import { Icon } from './Icon';
const meta = {
  title: 'Kiosk/Icon',
  component: Icon,
  decorators: [
    (Story) => (
      <Wrapper padding={28}>
        <Story />
      </Wrapper>
    ),
  ],
  args: { name: 'fast-food-outline', tone: 'brand', size: 'large' },
  tags: ['autodocs'],
} satisfies Meta<typeof Icon>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const LayeroArrow = { args: { name: 'arrow-forward' } };
export const LayeroBowl = { args: { name: 'restaurant-outline' } };
export const LayeroCheck = { args: { name: 'checkmark' } };
