import { forwardRef } from 'react';
import {
  Platform,
  StyleSheet,
  Text as NativeText,
  TextInput as NativeTextInput,
  type TextProps,
  type TextInputProps,
} from 'react-native';
import { useLocale } from '../i18n';
import { kazakhTextStyle } from '../i18n/typography';

export type Text = NativeText;
export type TextInput = NativeTextInput;

export const Text = forwardRef<NativeText, TextProps>(function LocalizedText(
  { style, ...props },
  ref,
) {
  const locale = useLocale();
  return (
    <NativeText
      {...props}
      ref={ref}
      style={[style, kazakhTextStyle(locale, StyleSheet.flatten(style), Platform.OS)]}
    />
  );
});

export const TextInput = Object.assign(
  forwardRef<NativeTextInput, TextInputProps>(function LocalizedTextInput(
    { style, ...props },
    ref,
  ) {
    const locale = useLocale();
    return (
      <NativeTextInput
        {...props}
        ref={ref}
        style={[style, kazakhTextStyle(locale, StyleSheet.flatten(style), Platform.OS)]}
      />
    );
  }),
  { State: NativeTextInput.State },
);
