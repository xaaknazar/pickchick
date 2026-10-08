import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { catalog, product, selections } from '../stories/fixtures';
import { ScreenSurface } from './ScreenSurface';
import { ScrollArea } from './ScrollArea';
import { ModifierOptions } from './ProductOptions';
import { ProductNutrition } from './ProductNutrition';
import { ProductIntro } from './ProductIntro';
const meta = {
  title: 'Kiosk/ProductIntro',
  component: ProductIntro,
  decorators: [
    (Story) => (
      <ScreenSurface tone="brand">
        <ScrollArea>
          <Story />
        </ScrollArea>
      </ScreenSurface>
    ),
  ],
  args: { product, locale: 'ru' },
  tags: ['autodocs'],
} satisfies Meta<typeof ProductIntro>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const WithOptions: Story = {
  args: {
    children: [
      <ModifierOptions
        key="drink"
        group={product.modifier_groups[0]!}
        selections={selections}
        setSelections={fn()}
        locale="ru"
      />,
      <ProductNutrition key="details" product={product} locale="ru" part="details" />,
    ],
  },
};
export const Single = { args: { product: catalog.products.find((p) => p.id === 'lemonade')! } };
export const Kazakh = { args: { locale: 'kk' } };
