import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { Wrapper } from './Wrapper';
import { Body } from './Body';
const meta = {
  title: 'Kiosk/Body',
  component: Body,
  decorators: [
    (Story) => (
      <Wrapper padding={28}>
        <Story />
      </Wrapper>
    ),
  ],
  args: { children: 'Хрустящая курочка, картофель и любимый соус' },
  tags: ['autodocs'],
} satisfies Meta<typeof Body>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Muted = { args: { tone: 'muted' } };
export const Caption = { args: { variant: 'caption' } };
export const Price = { args: { variant: 'price', children: '2 990 ₸' } };
