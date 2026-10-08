import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { Body, Button, ScreenSurface, Wrapper } from './UI';
import { ScreenTransition } from './ScreenTransition';
import { RevealCircle } from './RevealCircle';
const meta = {
  title: 'Kiosk/ScreenTransition',
  component: ScreenTransition,
  args: {
    screenKey: 'menu',
    children: (
      <ScreenSurface tone="brand">
        <Wrapper padding={28}>
          <Body tone="inverse">Меню</Body>
        </Wrapper>
      </ScreenSurface>
    ),
  },
  tags: ['autodocs'],
} satisfies Meta<typeof ScreenTransition>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
/** Switch screens: on iOS the previous one fades and shrinks to .97 underneath. */
export const Switching: Story = {
  render: function Render() {
    const [step, setStep] = useState<'menu' | 'cart'>('menu');
    const next = step === 'menu' ? 'cart' : 'menu';
    return (
      <ScreenTransition screenKey={step}>
        <ScreenSurface tone={step === 'menu' ? 'brand' : 'night'} entrance="forward">
          <Wrapper padding={28} gap={20}>
            <Body tone="inverse">{step === 'menu' ? 'Меню' : 'Корзина'}</Body>
            <Button
              label={next === 'menu' ? 'В меню' : 'В корзину'}
              onPress={() => setStep(next)}
            />
          </Wrapper>
        </ScreenSurface>
      </ScreenTransition>
    );
  },
};
/** A `reveal` screen opens as a circle over the still menu and closes back into it. */
export const Reveal: Story = {
  render: function Render() {
    const [step, setStep] = useState<'menu' | 'product'>('menu');
    const product = step === 'product';
    return (
      <ScreenTransition screenKey={step} reveal={product}>
        {product ? (
          <RevealCircle>
            <ScreenSurface tone="brand">
              <Wrapper padding={28} gap={20}>
                <Body tone="inverse">Pick Combo</Body>
                <Button label="Закрыть" onPress={() => setStep('menu')} />
              </Wrapper>
            </ScreenSurface>
          </RevealCircle>
        ) : (
          <ScreenSurface>
            <Wrapper padding={28} gap={20}>
              <Body>Меню</Body>
              <Button label="Открыть" onPress={() => setStep('product')} />
            </Wrapper>
          </ScreenSurface>
        )}
      </ScreenTransition>
    );
  },
};
