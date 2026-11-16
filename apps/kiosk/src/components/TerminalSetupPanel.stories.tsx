import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { fn } from 'storybook/test';
import { Wrapper } from './Wrapper';
import { TerminalSetupPanel } from './TerminalSetupPanel';
import { colors } from '../theme';
const linked = { terminalId: '30412345', serial: 'SPOS3A1B2C3', host: '192.168.1.50' };
const base = {
  open: true,
  confirming: false,
  result: null,
  link: null,
  cloudLinked: false,
  enabled: true,
};
/** ADR-0018 staff setup of the kiosk's Kaspi terminal. Synthetic: no terminal is called. */
const meta = {
  title: 'Kiosk/TerminalSetupPanel',
  component: TerminalSetupPanel,
  args: {
    view: base,
    host: '',
    onHostChange: fn(),
    locale: 'ru',
    onLink: fn(),
    onCheck: fn(),
    onUnlink: fn(),
  },
  decorators: [
    (Story) => (
      // Backdrop only: the panel is drawn inside the white staff dialog.
      <View style={{ flex: 1, backgroundColor: colors.white }}>
        <Wrapper padding={28} maxWidth={700}>
          <Story />
        </Wrapper>
      </View>
    ),
  ],
  tags: ['autodocs'],
} satisfies Meta<typeof TerminalSetupPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
/** Terminal link: enter the IP. */
export const EnterAddress: Story = { args: { host: '192.168.1.50' } };
export const WrongAddress: Story = { args: { host: '8.8.8.8', view: { ...base, result: 'host' } } };
export const NotAnswering: Story = {
  args: { host: '192.168.1.77', view: { ...base, result: 'unreachable' }, locale: 'kk' },
};
/** register sent: «Нажмите «Разрешить» на терминале». */
export const PressAllow: Story = {
  args: { host: '192.168.1.50', busy: true, view: { ...base, confirming: true } },
};
export const PressAllowEn: Story = {
  args: { host: '192.168.1.50', busy: true, locale: 'en', view: { ...base, confirming: true } },
};
export const Linked: Story = {
  args: { view: { ...base, link: linked, cloudLinked: true, result: 'linked' } },
};
export const LinkedNotSaved: Story = {
  args: { view: { ...base, link: linked, cloudLinked: false, result: 'cloud' } },
};
export const LinkedDisabledOnServer: Story = {
  args: { view: { ...base, link: linked, cloudLinked: true, enabled: false } },
};
export const TakenByAnotherKiosk: Story = {
  args: { host: '192.168.1.50', view: { ...base, result: 'taken' }, locale: 'en' },
};
export const Interactive: Story = {
  render: function Input(args) {
    const [host, setHost] = useState('');
    return <TerminalSetupPanel {...args} host={host} onHostChange={setHost} />;
  },
};
