import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { ScreenSurface } from './ScreenSurface';
import { Wrapper } from './Wrapper';
import { Heading } from './Heading';
import { ModeReveal } from './ModeReveal';
import { armReveal, type RevealMode } from './reveal';
/** A stand-in dining tile: the reveal only needs the tile's window rectangle. */
const tile = (x: number, y: number) => ({
  measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) =>
    done(x, y, 320, 220),
});
/** Arms a tap on the stand-in tile, then mounts the reveal as the menu would. */
function Replay({ mode }: { mode: RevealMode }) {
  const [round, setRound] = useState(0);
  useEffect(() => {
    armReveal(mode, tile(40, mode === 'takeaway' ? 320 : 80));
    const timer = setTimeout(() => setRound(1), 30);
    return () => clearTimeout(timer);
  }, [mode]);
  return round ? <ModeReveal mode={mode} /> : null;
}
const meta = {
  title: 'Kiosk/ModeReveal',
  component: ModeReveal,
  decorators: [
    (Story) => (
      <ScreenSurface tone="brand">
        <Wrapper flex={1} padding={40}>
          <Heading size="title" tone="inverse">
            Меню
          </Heading>
        </Wrapper>
        <Story />
      </ScreenSurface>
    ),
  ],
  args: { mode: 'dine_in' },
  render: (args) => <Replay mode={args.mode ?? 'dine_in'} />,
  tags: ['autodocs'],
} satisfies Meta<typeof ModeReveal>;
export default meta;
type Story = StoryObj<typeof meta>;
export const DineIn: Story = {};
export const Takeaway: Story = { args: { mode: 'takeaway' } };
