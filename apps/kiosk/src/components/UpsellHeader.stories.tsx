import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { copy } from '../i18n';
import { ScreenSurface } from './ScreenSurface';
import { RadialBackdrop } from './RadialBackdrop';
import { UpsellHeader } from './UpsellHeader';
const meta = {
  title: 'Kiosk/Redesign/UpsellHeader',
  component: UpsellHeader,
  decorators: [
    (Story) => (
      <ScreenSurface tone="brand">
        <RadialBackdrop />
        <Story />
      </ScreenSurface>
    ),
  ],
  args: {
    locale: 'ru',
    setLocale: fn(),
    title: copy('ru').smartTitle,
    subtitle: copy('ru').smartSubFingers.replace('{items}', 'Pick Combo'),
    onBack: fn(),
    onHelp: fn(),
  },
  tags: ['autodocs'],
} satisfies Meta<typeof UpsellHeader>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Kazakh: Story = {
  args: {
    locale: 'kk',
    title: copy('kk').smartTitle,
    subtitle: copy('kk').smartSubBurger.replace('{items}', 'Burger Combo'),
  },
};
export const English: Story = {
  args: {
    locale: 'en',
    title: copy('en').smartTitle,
    subtitle: copy('en').smartSubOrder.replace('{items}', 'Iced tea +1'),
  },
};
