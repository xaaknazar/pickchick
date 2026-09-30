import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { authColors } from './AuthLayout';
import { BirthDatePickerSheet } from './BirthDatePickerSheet';
import {
  almatyToday,
  allowedBirthDate,
  birthDateAtLocalNoon,
  birthDateFromNative,
  initialBirthDate,
  MINIMUM_BIRTH_DATE,
  type BirthDatePickerProps,
} from './birth-date-picker';

function AndroidBirthDatePicker({ value, onConfirm, onCancel }: BirthDatePickerProps) {
  const callbacks = useRef({ onConfirm, onCancel });
  const [options] = useState(() => {
    const maximum = almatyToday();
    return {
      maximum,
      value: birthDateAtLocalNoon(initialBirthDate(value, maximum)),
      minimumDate: birthDateAtLocalNoon(MINIMUM_BIRTH_DATE),
      maximumDate: birthDateAtLocalNoon(maximum),
    };
  });
  useEffect(() => {
    callbacks.current = { onConfirm, onCancel };
  }, [onConfirm, onCancel]);

  useEffect(() => {
    let active = true;
    let opened = false;
    let settled = false;
    const cancel = () => {
      if (!active || settled) return;
      settled = true;
      callbacks.current.onCancel();
    };
    // Delay presentation one task so StrictMode's setup/cleanup replay cannot
    // open a dialog which immediately dismisses the next instance's dialog.
    const timer = setTimeout(() => {
      if (!active) return;
      opened = true;
      DateTimePickerAndroid.open({
        testID: 'birthday-native-input',
        mode: 'date',
        display: 'default',
        value: options.value,
        minimumDate: options.minimumDate,
        maximumDate: options.maximumDate,
        positiveButton: { label: 'Готово' },
        negativeButton: { label: 'Отмена' },
        onValueChange: (_event, date) => {
          if (!active || settled) return;
          const selected = birthDateFromNative(date);
          if (!allowedBirthDate(selected, options.maximum)) {
            cancel();
            return;
          }
          settled = true;
          callbacks.current.onConfirm(selected);
        },
        onDismiss: cancel,
        onError: cancel,
      });
    }, 0);
    return () => {
      active = false;
      clearTimeout(timer);
      if (opened && !settled) void DateTimePickerAndroid.dismiss('date').catch(() => undefined);
    };
  }, [options]);

  return <View testID="birthday-picker" />;
}

function IOSBirthDatePicker({ value, onConfirm, onCancel }: BirthDatePickerProps) {
  const [maximum] = useState(almatyToday);
  const [initialDate] = useState(() => birthDateAtLocalNoon(initialBirthDate(value, maximum)));
  const selected = useRef(birthDateFromNative(initialDate));
  return (
    <BirthDatePickerSheet
      onCancel={onCancel}
      onConfirm={() => {
        if (allowedBirthDate(selected.current, maximum)) onConfirm(selected.current);
      }}
    >
      <DateTimePicker
        testID="birthday-native-input"
        accessibilityLabel="Дата рождения"
        // Native owns wheel movement. Echoing intermediate dates back through
        // Fabric can interrupt a fast scroll and reset it to an earlier day.
        value={initialDate}
        mode="date"
        display="spinner"
        locale="ru-RU"
        themeVariant="dark"
        textColor={authColors.text}
        minimumDate={birthDateAtLocalNoon(MINIMUM_BIRTH_DATE)}
        maximumDate={birthDateAtLocalNoon(maximum)}
        onValueChange={(_event, date) => {
          const next = birthDateFromNative(date);
          if (allowedBirthDate(next, maximum)) selected.current = next;
        }}
        style={s.wheel}
      />
    </BirthDatePickerSheet>
  );
}

export default function BirthDatePicker(props: BirthDatePickerProps) {
  return Platform.OS === 'android' ? (
    <AndroidBirthDatePicker {...props} />
  ) : (
    <IOSBirthDatePicker {...props} />
  );
}

const s = StyleSheet.create({ wheel: { alignSelf: 'center', width: '100%', height: 216 } });
