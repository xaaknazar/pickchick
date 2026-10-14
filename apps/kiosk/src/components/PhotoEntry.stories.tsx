import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { PhotoEntry } from './PhotoEntry';
const meta = {
  title: 'Kiosk/PhotoEntry',
  component: PhotoEntry,
  args: { locale: 'ru', onInteraction: fn() },
} satisfies Meta<typeof PhotoEntry>;
export default meta;
export const Default: StoryObj<typeof meta> = {};
