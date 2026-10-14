import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { PhotoBooth } from './PhotoBooth';
import { PhotoController } from '../photobooth/controller';
import { createPhotoIO } from '../photobooth/io';
const intro = new PhotoController(createPhotoIO());
intro.state = { ...intro.state, ready: true };
const sent = new PhotoController(createPhotoIO());
sent.state = {
  ...sent.state,
  ready: true,
  phase: 'result',
  job: { id: 'story-only', previewId: 'story-only', state: 'sent' },
};
const unknown = new PhotoController(createPhotoIO());
unknown.state = { ...unknown.state, ready: true, phase: 'result', error: 'UNKNOWN' };
const meta = {
  title: 'Kiosk/PhotoBooth',
  component: PhotoBooth,
  args: { locale: 'ru', onClose: fn(), onInteraction: fn(), controller: intro },
} satisfies Meta<typeof PhotoBooth>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Intro: Story = {};
export const Sent: Story = { args: { controller: sent } };
export const Unknown: Story = { args: { controller: unknown } };
export const Kazakh: Story = { args: { locale: 'kk' } };
