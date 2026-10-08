import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { Button } from './Button';
import { ScreenSurface } from './ScreenSurface';
import { Wrapper } from './Wrapper';
import { PaidStamp } from './PaidStamp';
const meta = {
  title: 'Kiosk/PaidStamp',
  component: PaidStamp,
  decorators: [
    (Story) => (
      <ScreenSurface tone="brand">
        <View style={{ height: 720 }}>
          <Story />
        </View>
      </ScreenSurface>
    ),
  ],
  args: { label: 'Оплачено', active: true },
  tags: ['autodocs'],
} satisfies Meta<typeof PaidStamp>;
export default meta;
type Story = StoryObj<typeof meta>;
/** Plays once on mount (about 1.3 s), then leaves nothing behind. */
export const Default: Story = {};
export const Kazakh: Story = { args: { label: 'Төленді' } };
/** Replays the paid beat each time the button is tapped. */
export const Replay: Story = {
  render: function Again(args) {
    const [run, setRun] = useState(0);
    return (
      <View style={{ flex: 1 }}>
        <PaidStamp key={run} {...args} />
        <Wrapper padding={28}>
          <Button label="Ещё раз" size="compact" onPress={() => setRun((n) => n + 1)} />
        </Wrapper>
      </View>
    );
  },
};
