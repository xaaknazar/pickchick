import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { ScreenSurface } from './ScreenSurface';
import { DemoBadge } from './DemoBadge';
const meta = {
  title: 'Kiosk/DemoBadge',
  component: DemoBadge,
  decorators: [
    (Story) => (
      <ScreenSurface tone="brand">
        <Story />
      </ScreenSurface>
    ),
  ],
  args: { locale: 'ru', onExit: fn() },
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'Бейдж демо-режима для персонала (решение владельца 2026-10-11): виден на всех экранах, кнопка «Выйти из демо». Настоящих заказов и оплат в демо нет.',
      },
    },
  },
} satisfies Meta<typeof DemoBadge>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Russian: Story = {};
export const Kazakh: Story = { args: { locale: 'kk' } };
export const English: Story = { args: { locale: 'en' } };
