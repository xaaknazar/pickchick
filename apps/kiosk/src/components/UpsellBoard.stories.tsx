import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { copy } from '../i18n';
import { catalog } from '../stories/fixtures';
import { ScreenSurface } from './ScreenSurface';
import { RadialBackdrop } from './RadialBackdrop';
import { ScrollArea } from './ScrollArea';
import { Wrapper } from './Wrapper';
import { UpsellHero, UpsellTile } from './UpsellCards';
import { UpsellSection } from './UpsellSection';
import { UpsellBoard } from './UpsellBoard';
const product = (id: string) => catalog.products.find((p) => p.id === id)!;
const ru = copy('ru');
const tile = (id: string, name: string, art: number, wide: boolean, flex = 1) => (
  <Wrapper key={id} flex={flex}>
    <UpsellTile
      product={product(id)}
      name={name}
      badge={
        id === 'lemonade' ? 'lemonade' : id === 'sauce' ? 'hit' : id === 'sauce-hot' ? 'hot' : null
      }
      description={id === 'lemonade' ? ru.smartBodyLemonade : undefined}
      layout={wide ? 'wide' : 'tall'}
      art={art}
      added={false}
      busy={false}
      locale="ru"
      onAdd={fn()}
    />
  </Wrapper>
);
const meta = {
  title: 'Kiosk/Redesign/UpsellBoard',
  component: UpsellBoard,
  decorators: [
    (Story) => (
      <ScreenSurface tone="brand">
        <RadialBackdrop />
        <ScrollArea fill>
          <Story />
        </ScrollArea>
      </ScreenSurface>
    ),
  ],
  args: {
    children: [
      <UpsellHero
        key="hero"
        product={product('burger')}
        badge="toFingers"
        title={ru.smartHeroBurger}
        body={ru.smartBodyBurgerPair}
        added={false}
        busy={false}
        locale="ru"
        onAdd={fn()}
      />,
      <UpsellSection key="sauces" title={ru.smartSauces} note={ru.smartSaucesNote}>
        {tile('sauce', ru.smartSauce, 1, true)}
        {tile('sauce-hot', ru.smartSauceHot, 2, true)}
      </UpsellSection>,
      <UpsellSection key="drinks" title={ru.drinks}>
        {tile('lemonade', ru.smartLemonade, 0, true, 1.4)}
        {tile('iced-tea', ru.smartIcedTea, 2, false)}
        {tile('cola', ru.smartCola, 3, false)}
      </UpsellSection>,
    ],
  },
  tags: ['autodocs'],
} satisfies Meta<typeof UpsellBoard>;
export default meta;
type Story = StoryObj<typeof meta>;
/** The smart upsell content for an order with fingers: burger on top, sauces, drinks. */
export const Fingers: Story = {};
