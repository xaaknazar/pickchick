import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { ScreenSurface } from './ScreenSurface';
import { Wrapper } from './Wrapper';
import { GlassPanel } from './GlassPanel';
import { Body } from './Body';
const meta = {
  title: 'Kiosk/Redesign/GlassPanel',
  component: GlassPanel,
  decorators: [
    (Story) => (
      <ScreenSurface tone="brand">
        <Wrapper padding={28} gap={20}>
          <Story />
        </Wrapper>
      </ScreenSurface>
    ),
  ],
  args: {
    shape: 'pill',
    children: (
      <Wrapper paddingX={24} paddingY={14}>
        <Body tone="inverse">В зале · С собой</Body>
      </Wrapper>
    ),
  },
  tags: ['autodocs'],
} satisfies Meta<typeof GlassPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Pill: Story = {};
export const Bar: Story = { args: { shape: 'bar' } };
export const Circle: Story = {
  args: {
    shape: 'circle',
    children: (
      <Wrapper padding={18}>
        <Body tone="inverse">×</Body>
      </Wrapper>
    ),
  },
};
