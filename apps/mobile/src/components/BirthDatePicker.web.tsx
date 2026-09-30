import { useState, type CSSProperties } from 'react';
import { StyleSheet, View } from 'react-native';
import { font } from '../theme';
import { authColors } from './AuthLayout';
import { BirthDatePickerSheet } from './BirthDatePickerSheet';
import {
  almatyToday,
  allowedBirthDate,
  initialBirthDate,
  MINIMUM_BIRTH_DATE,
  type BirthDatePickerProps,
} from './birth-date-picker';

export default function BirthDatePicker({ value, onConfirm, onCancel }: BirthDatePickerProps) {
  const [maximum] = useState(almatyToday);
  const [initial] = useState(() => initialBirthDate(value, maximum));
  const [draft, setDraft] = useState(initial);
  const valid = allowedBirthDate(draft, maximum);
  return (
    <BirthDatePickerSheet
      onCancel={onCancel}
      onConfirm={() => {
        if (valid) onConfirm(draft);
      }}
      confirmDisabled={!valid}
    >
      <View style={s.inputContainer}>
        <input
          data-testid="birthday-native-input"
          aria-label="Дата рождения"
          type="date"
          min={MINIMUM_BIRTH_DATE}
          max={maximum}
          defaultValue={initial}
          onChange={(event) => setDraft(event.currentTarget.value)}
          style={inputStyle}
        />
      </View>
    </BirthDatePickerSheet>
  );
}

const s = StyleSheet.create({ inputContainer: { paddingHorizontal: 22, paddingVertical: 20 } });
const inputStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  minWidth: 0,
  minHeight: 54,
  padding: '12px 16px',
  borderRadius: 16,
  border: `1px solid ${authColors.border}`,
  background: authColors.background,
  color: authColors.text,
  colorScheme: 'dark',
  fontFamily: `${font.heading}, sans-serif`,
  fontSize: 20,
};
