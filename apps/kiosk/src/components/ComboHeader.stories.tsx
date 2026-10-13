import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { fn } from 'storybook/test';
import { redesign } from '../theme';
import { ComboHeader } from './ComboHeader';
const meta = {
  title: 'Kiosk/Redesign/ComboHeader',
  component: ComboHeader,
  decorators: [
    (Story) => (
      // Backdrop only: the header sits on the blue product card screen.
      <View style={{ backgroundColor: redesign.screen[1], paddingBottom: 24 }}>
        <Story />
      </View>
    ),
  ],
  args: {
    locale: 'ru',
    setLocale: fn(),
    title: 'Pick Combo',
    subtitle: 'Комбо · 520 г',
    back: 'Меню',
    onBack: fn(),
    onHelp: fn(),
  },
  tags: ['autodocs'],
} satisfies Meta<typeof ComboHeader>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Kazakh: Story = {
  args: { locale: 'kk', title: 'Фингер Дуо', subtitle: 'Екеуге · 1100 г', back: 'Мәзір' },
};
/** Opened from the order (smart upsell): the pill goes back there. */
export const FromOrder: Story = {
  args: { locale: 'en', title: 'Master Combo', subtitle: 'Combo · 720 g', back: 'Back' },
};
