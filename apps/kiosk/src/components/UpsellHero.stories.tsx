import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { copy } from '../i18n';
import { catalog } from '../stories/fixtures';
import { ScreenSurface } from './ScreenSurface';
import { RadialBackdrop } from './RadialBackdrop';
import { Wrapper } from './Wrapper';
import { UpsellHero } from './UpsellCards';
const product = (id: string) => catalog.products.find((p) => p.id === id)!;
const ru = copy('ru');
const meta = {
  title: 'Kiosk/Redesign/UpsellHero',
  component: UpsellHero,
  decorators: [
    (Story) => (
      <ScreenSurface tone="brand">
        <RadialBackdrop />
        <Wrapper padding={16}>
          <Story />
        </Wrapper>
      </ScreenSurface>
    ),
  ],
  args: {
    product: product('burger'),
    badge: 'toFingers',
    title: ru.smartHeroBurger,
    body: ru.smartBodyBurgerPair,
    added: false,
    busy: false,
    locale: 'ru',
    onAdd: fn(),
  },
  tags: ['autodocs'],
} satisfies Meta<typeof UpsellHero>;
export default meta;
type Story = StoryObj<typeof meta>;
/** An order with fingers and no burger. */
export const BurgerToFingers: Story = {};
/** An order with a burger and no fingers. */
export const FingersToBurger: Story = {
  args: {
    product: product('fingers'),
    badge: 'toBurger',
    title: ru.smartHeroFingers,
    body: ru.smartBodyFingersPair.replace('{price}', '690 ₸'),
  },
};
/** Both mains in the order: the lemonade, the drinks hit. */
export const Lemonade: Story = {
  args: {
    product: product('lemonade'),
    badge: 'lemonade',
    title: ru.smartHeroLemonade,
    body: ru.smartBodyLemonade,
  },
};
export const Added: Story = { args: { added: true } };
export const Kazakh: Story = {
  args: {
    locale: 'kk',
    title: copy('kk').smartHeroBurger,
    body: copy('kk').smartBodyBurgerPair,
  },
};
/** Tap to toggle: the + turns into the green check and the green ring. */
export const Toggle: Story = {
  render: function ToggleStory(args) {
    const [added, setAdded] = useState(false);
    return <UpsellHero {...args} added={added} onAdd={() => setAdded((a) => !a)} />;
  },
};
