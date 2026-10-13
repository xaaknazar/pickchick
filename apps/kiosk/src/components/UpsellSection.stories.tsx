import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { copy } from '../i18n';
import { catalog } from '../stories/fixtures';
import { ScreenSurface } from './ScreenSurface';
import { RadialBackdrop } from './RadialBackdrop';
import { Wrapper } from './Wrapper';
import { UpsellTile } from './UpsellCards';
import { UpsellSection } from './UpsellSection';
const product = (id: string) => catalog.products.find((p) => p.id === id)!;
const ru = copy('ru');
const tile = (id: string, name: string, art: number, wide = false) => (
  <Wrapper key={id} flex={wide ? 1.4 : 1}>
    <UpsellTile
      product={product(id)}
      name={name}
      badge={id === 'lemonade' ? 'lemonade' : null}
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
  title: 'Kiosk/Redesign/UpsellSection',
  component: UpsellSection,
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
    title: ru.drinks,
    children: [
      tile('lemonade', ru.smartLemonade, 0, true),
      tile('iced-tea', ru.smartIcedTea, 2),
      tile('cola', ru.smartCola, 3),
    ],
  },
  tags: ['autodocs'],
} satisfies Meta<typeof UpsellSection>;
export default meta;
type Story = StoryObj<typeof meta>;
/** «Напитки»: the wide lemonade and two cards. */
export const Drinks: Story = {};
/** «Соусы - к любому заказу» while the catalog has no cheese sauce: two wide cards. */
export const Sauces: Story = {
  args: {
    title: ru.smartSauces,
    note: ru.smartSaucesNote,
    children: [tile('sauce', ru.smartSauce, 1, true), tile('sauce-hot', ru.smartSauceHot, 2, true)],
  },
};
