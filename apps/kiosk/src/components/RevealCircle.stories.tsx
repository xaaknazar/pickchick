import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { Body, Button, Heading, ScreenSurface, Wrapper } from './UI';
import { RevealCircle } from './RevealCircle';
import { noteProductOrigin } from './reveal';
/** A stand-in menu card: the circle only needs the card's window rectangle. */
const card = {
  measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) =>
    done(180, 520, 300, 360),
};
/** Notes a tap on the stand-in card, then mounts the page as the app would. */
function Replay({ round, onReplay }: { round: number; onReplay: () => void }) {
  const [ready, setReady] = useState(0);
  useEffect(() => {
    noteProductOrigin(card);
    const timer = setTimeout(() => setReady(round), 30);
    return () => clearTimeout(timer);
  }, [round]);
  return ready === round ? (
    <RevealCircle key={round}>
      <ScreenSurface tone="brand">
        <Wrapper padding={40} gap={20}>
          <Heading size="title" tone="inverse">
            Pick Combo
          </Heading>
          <Body tone="onBlue">The page opens as a circle from the tapped card.</Body>
          <Button label="Ещё раз" onPress={onReplay} />
        </Wrapper>
      </ScreenSurface>
    </RevealCircle>
  ) : null;
}
const meta = {
  title: 'Kiosk/RevealCircle',
  component: RevealCircle,
  decorators: [
    (Story) => (
      <ScreenSurface>
        <Wrapper padding={40}>
          <Heading size="title">Меню</Heading>
        </Wrapper>
        <Wrapper flex={1}>
          <Story />
        </Wrapper>
      </ScreenSurface>
    ),
  ],
  render: function Render() {
    const [round, setRound] = useState(1);
    return <Replay round={round} onReplay={() => setRound((n) => n + 1)} />;
  },
  tags: ['autodocs'],
} satisfies Meta<typeof RevealCircle>;
export default meta;
type Story = StoryObj<typeof meta>;
/** Opens from the stand-in card's centre (closing plays when the app leaves the page). */
export const FromCard: Story = {};
/** Without a recent tap the circle opens from the middle of the screen. */
export const FromCentre: Story = {
  render: () => (
    <RevealCircle>
      <ScreenSurface tone="brand">
        <Wrapper padding={40}>
          <Button label="Добавить" onPress={fn()} />
        </Wrapper>
      </ScreenSurface>
    </RevealCircle>
  ),
};
