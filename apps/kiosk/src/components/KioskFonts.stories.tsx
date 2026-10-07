import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { Heading } from './UI';
import { KioskFonts } from './KioskFonts';
const meta = {
  title: 'Kiosk/KioskFonts',
  component: KioskFonts,
  args: { children: <Heading>Pick Chick · Қазақша · Русский</Heading> },
  tags: ['autodocs'],
} satisfies Meta<typeof KioskFonts>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
