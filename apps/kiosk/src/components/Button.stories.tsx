import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { Wrapper } from './Wrapper';
import { Button } from './Button';
const meta = {
  title: 'Kiosk/Button',
  component: Button,
  decorators: [
    (Story) => (
      <Wrapper padding={28}>
        <Story />
      </Wrapper>
    ),
  ],
  args: { label: 'В корзину · 2 990 ₸', onPress: fn() },
  tags: ['autodocs'],
} satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Disabled = { args: { disabled: true } };
export const Loading = { args: { busy: true } };
export const Secondary = { args: { tone: 'secondary' } };
export const Primary = { args: { tone: 'primary' } };
export const Compact = { args: { size: 'compact' } };
/** A live "next" arrow nudges forward (kNudge, 1.4 s); still once disabled. */
export const Next = { args: { label: 'Оформить заказ', icon: 'arrow-forward' } };
export const NextDisabled = {
  args: { label: 'Оформить заказ', icon: 'arrow-forward', disabled: true },
};
/** Prototype `.newo`: the peach countdown band grows 1 s per tick under the label. */
export const Countdown = {
  args: { label: 'Новый заказ · 9', tone: 'secondary', progress: 6 / 15 },
};
/** Enabling crossfades the fill (260 ms); tap the outer button to toggle. */
export const EnableCrossfade: Story = {
  render: function Toggle(args) {
    const [disabled, setDisabled] = useState(true);
    return (
      <Wrapper gap={16}>
        <Button {...args} label="Выставить счёт" icon="arrow-forward" disabled={disabled} />
        <Button
          label={disabled ? 'Ввести номер' : 'Стереть номер'}
          tone="secondary"
          size="compact"
          onPress={() => setDisabled((value) => !value)}
        />
      </Wrapper>
    );
  },
};
/** The live countdown on the done screen: 15 s, then it starts over. */
export const CountdownLive: Story = {
  render: function Live(args) {
    const [left, setLeft] = useState(15);
    useEffect(() => {
      const timer = setInterval(() => setLeft((value) => (value <= 0 ? 15 : value - 1)), 1000);
      return () => clearInterval(timer);
    }, []);
    return (
      <Button
        {...args}
        label={`Новый заказ · ${left}`}
        tone="secondary"
        progress={(15 - left) / 15}
      />
    );
  },
};
