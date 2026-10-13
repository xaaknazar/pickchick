import { useState } from 'react';
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
const meta = {
  title: 'Kiosk/Redesign/UpsellTile',
  component: UpsellTile,
  decorators: [
    (Story) => (
      <ScreenSurface tone="brand">
        <RadialBackdrop />
        <Wrapper padding={16} maxWidth={440}>
          <UpsellSection title={ru.smartSauces}>
            <Wrapper flex={1}>
              <Story />
            </Wrapper>
          </UpsellSection>
        </Wrapper>
      </ScreenSurface>
    ),
  ],
  args: {
    product: product('sauce'),
    name: ru.smartSauce,
    badge: 'hit',
    layout: 'tall',
    art: 1,
    position: 0,
    added: false,
    busy: false,
    locale: 'ru',
    onAdd: fn(),
  },
  tags: ['autodocs'],
} satisfies Meta<typeof UpsellTile>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Sauce: Story = {};
export const Hot: Story = {
  args: { product: product('sauce-hot'), name: ru.smartSauceHot, badge: 'hot', art: 2 },
};
export const Added: Story = { args: { added: true } };
/** The drinks row's wide lemonade card. */
export const Lemonade: Story = {
  args: {
    product: product('lemonade'),
    name: ru.smartLemonade,
    badge: 'lemonade',
    description: ru.smartBodyLemonade,
    layout: 'wide',
    art: 0,
  },
};
export const Busy: Story = { args: { busy: true } };
export const Kazakh: Story = {
  args: { locale: 'kk', product: product('iced-tea'), name: copy('kk').smartIcedTea, badge: null },
};
/** Tap to toggle: the + turns into the green check and the green ring. */
export const Toggle: Story = {
  render: function ToggleStory(args) {
    const [added, setAdded] = useState(false);
    return <UpsellTile {...args} added={added} onAdd={() => setAdded((a) => !a)} />;
  },
};
