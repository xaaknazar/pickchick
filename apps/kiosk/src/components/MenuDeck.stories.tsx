import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { fn } from 'storybook/test';
import { redesign } from '../theme';
import { catalog, memory } from '../stories/fixtures';
import { inCategory } from './categories';
import { MenuDeck } from './MenuDeck';
import { MenuGrid } from './MenuGrid';
const meta = {
  title: 'Kiosk/MenuDeck',
  component: MenuDeck,
  decorators: [
    (Story) => (
      // Backdrop only: the sections live on the redesigned blue menu.
      <View style={{ width: 822, height: 1238, backgroundColor: redesign.screen[1] }}>
        <Story />
      </View>
    ),
  ],
  args: {
    category: 'combo',
    revision: 0,
    children: (section, active) => (
      <MenuGrid
        active={active}
        products={catalog.products.filter((p) => inCategory(p, section))}
        category={section}
        memory={memory}
        locale="ru"
        busy={false}
        onOpen={fn()}
        onAdd={fn()}
        onInteraction={fn()}
      />
    ),
  },
  tags: ['autodocs'],
} satisfies Meta<typeof MenuDeck>;
export default meta;
type Story = StoryObj<typeof meta>;
/** The open section; on the iPad the others are built underneath and cross-fade in. */
export const Combo: Story = {};
/** Another open section. */
export const Extras: Story = { args: { category: 'extras' } };
