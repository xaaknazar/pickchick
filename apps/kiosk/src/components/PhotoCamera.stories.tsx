import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { PhotoCamera } from './PhotoCamera';
const meta = {
  title: 'Kiosk/PhotoCamera',
  component: PhotoCamera,
  args: { locale: 'ru', shot: 0, onReady: fn(), onCapture: fn(), onError: fn() },
} satisfies Meta<typeof PhotoCamera>;
export default meta;
export const Permission: StoryObj<typeof meta> = {};
