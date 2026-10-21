import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { ScreenSurface } from './ScreenSurface';
import { Wrapper } from './Wrapper';
import { SaluteButton } from './SaluteButton';
const meta = {
  title: 'Kiosk/Redesign/SaluteButton',
  component: SaluteButton,
  decorators: [
    (Story) => (
      // Backdrop only: the start CTA sits on the dark film with room for the sparks.
      <ScreenSurface tone="dark">
        <Wrapper paddingX={48} paddingY={160}>
          <Story />
        </Wrapper>
      </ScreenSurface>
    ),
  ],
  args: { label: 'СДЕЛАТЬ ЗАКАЗ', onPress: fn(), testID: 'kiosk-start' },
  tags: ['autodocs'],
} satisfies Meta<typeof SaluteButton>;
export default meta;
type Story = StoryObj<typeof meta>;
/** 2.8 s loop: spring, light sweep and fourteen sparks (static if the OS reduces motion). */
export const Default: Story = {};
export const Kazakh: Story = { args: { label: 'ТАПСЫРЫС БЕРУ' } };
export const English: Story = { args: { label: 'ORDER NOW' } };
/** The resting frame used under reduced motion: scale 1, no sweep, no sparks. */
export const ReducedMotion: Story = { args: { still: true } };
/** Starting a session: disabled, dimmed, spinner and no salute. */
export const Busy: Story = { args: { busy: true } };
