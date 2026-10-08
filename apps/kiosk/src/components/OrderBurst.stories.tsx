import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { Button } from './Button';
import { ScreenSurface } from './ScreenSurface';
import { Wrapper } from './Wrapper';
import { OrderBurst } from './OrderBurst';
const meta = {
  title: 'Kiosk/OrderBurst',
  component: OrderBurst,
  decorators: [
    (Story) => (
      // Backdrop only: the burst is a zero-size anchor at the centre of the blue screen.
      <ScreenSurface tone="brand">
        <View style={{ height: 900, alignItems: 'center', justifyContent: 'center' }}>
          <Story />
        </View>
      </ScreenSurface>
    ),
  ],
  args: { after: 0 },
  tags: ['autodocs'],
} satisfies Meta<typeof OrderBurst>;
export default meta;
type Story = StoryObj<typeof meta>;
/** Ten cut-outs fly out 520 ms after mount, 30 ms apart, and fade (1.6 s each). */
export const Default: Story = {};
/** Replays the burst each time the button is tapped. */
export const Replay: Story = {
  render: function Again(args) {
    const [run, setRun] = useState(0);
    return (
      <View style={{ alignItems: 'center' }}>
        <OrderBurst key={run} {...args} />
        <Wrapper padding={28}>
          <Button label="Ещё раз" size="compact" onPress={() => setRun((n) => n + 1)} />
        </Wrapper>
      </View>
    );
  },
};
