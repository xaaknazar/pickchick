import { MotionPressable as Pressable } from '../components/Motion';
import { useEffect, useRef, useState } from 'react';
import { Keyboard, StyleSheet, TextInput, View, useWindowDimensions } from 'react-native';
import type { ScreenProps } from '../model';
import { useAccount } from '../useAccount';
import { isValidBirthDate, type DemoProfileInput } from '../profile-details';
import { font } from '../theme';
import { AuthButton, AuthLayout, authColors } from '../components/AuthLayout';
import { Body, Caption, Icon } from '../components/UI';
import BirthDatePicker from '../components/BirthDatePicker';

/** Registration and subsequent editing share the original mockup's form. */
export function Onboarding(props: ScreenProps) {
  const demo = useAccount();
  const { fontScale } = useWindowDimensions();
  const profile = demo.account?.profile;
  const savedNickname =
    profile && profile.completedAt !== null
      ? profile.nickname
      : profile?.nickname || props.model.nickname;
  const [nickname, setNickname] = useState(savedNickname);
  const nicknameEdited = useRef(false);
  const [nicknameRevision, setNicknameRevision] = useState(0);
  const [birthDate, setBirthDate] = useState<string | null>(profile?.birthDate ?? null);
  const dateLabel = birthDate
    ? new Date(`${birthDate}T12:00:00`)
        .toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
        .replace(' г.', '')
    : 'Выбрать';
  const [gender, setGender] = useState<DemoProfileInput['gender']>(profile?.gender ?? null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const accountKey = `${demo.account?.phone ?? 'guest'}:${profile?.completedAt ?? 'new'}`;
  useEffect(() => {
    nicknameEdited.current = false;
    setNickname(savedNickname);
    setBirthDate(profile?.birthDate ?? null);
    setGender(profile?.gender ?? null);
    setPickerOpen(false);
    setSubmitted(false);
    // Hydrate on account restore/save, never overwrite a field while typing.
  }, [accountKey]);

  useEffect(() => {
    // v1 kept nickname in a separate preferences record which may restore later.
    // Hydrate it once without replacing any text the user has already entered.
    if (profile?.completedAt === null && !nicknameEdited.current) {
      setNickname(savedNickname);
      setNicknameRevision((revision) => revision + 1);
    }
  }, [savedNickname, accountKey]);

  const dateError =
    birthDate && !isValidBirthDate(birthDate)
      ? 'Проверьте дату: она должна существовать и не быть в будущем.'
      : null;
  const nameLength = Array.from(nickname.trim()).length;
  const canSave =
    demo.ready &&
    !demo.busy &&
    !pickerOpen &&
    Boolean(demo.account) &&
    !props.preview &&
    !dateError &&
    gender !== null &&
    nameLength <= 32;
  const editing = profile?.completedAt !== null && profile?.completedAt !== undefined;
  const openPicker = () => {
    Keyboard.dismiss();
    setPickerOpen(true);
    setSubmitted(false);
  };
  const save = async () => {
    setSubmitted(true);
    if (!canSave || props.preview) return;
    if (await demo.saveProfile({ nickname, birthDate, gender })) {
      props.model.setNickname(nickname.trim());
      Keyboard.dismiss();
      props.navigate(editing ? 'M30' : 'M06');
    }
  };

  return (
    <AuthLayout
      props={props}
      title={editing ? 'Мои данные' : 'Знакомимся'}
      subtitle="Как к вам обращаться и когда поздравить"
      overlay={
        pickerOpen ? (
          <BirthDatePicker
            value={birthDate}
            onConfirm={(selected) => {
              setBirthDate(selected);
              setPickerOpen(false);
              setSubmitted(false);
            }}
            onCancel={() => setPickerOpen(false)}
          />
        ) : null
      }
      footer={
        <>
          <AuthButton
            title={demo.busy ? 'Сохраняем…' : editing ? 'Сохранить' : 'Готово'}
            testID="nickname-save"
            disabled={!canSave}
            onPress={() => void save()}
          />
          {editing ? (
            <Pressable
              testID="profile-fill-later"
              accessibilityRole="button"
              disabled={demo.busy}
              onPress={() => {
                Keyboard.dismiss();
                props.navigate('M30');
              }}
              style={({ pressed }) => [s.later, pressed && s.pressed]}
            >
              <Body style={s.laterText}>Отмена</Body>
            </Pressable>
          ) : null}
        </>
      }
    >
      <View style={s.group}>
        <View style={s.formRow}>
          <Body style={s.rowLabel}>Никнейм</Body>
          <TextInput
            key={`${accountKey}:${nicknameRevision}`}
            testID="nickname-input"
            accessibilityLabel="Никнейм"
            defaultValue={savedNickname}
            onChangeText={(value) => {
              nicknameEdited.current = true;
              setNickname(value);
              setSubmitted(false);
            }}
            editable={demo.ready && !demo.busy}
            placeholder="Ваше имя"
            placeholderTextColor={authColors.muted}
            autoComplete="nickname"
            autoCorrect={false}
            spellCheck={false}
            smartInsertDelete={false}
            autoCapitalize="none"
            maxLength={64}
            returnKeyType="done"
            onSubmitEditing={Keyboard.dismiss}
            underlineColorAndroid="transparent"
            style={s.nicknameInput}
          />
        </View>
        <Pressable
          testID="birthday-open"
          accessibilityRole="button"
          accessibilityLabel={`Дата рождения: ${dateLabel}`}
          accessibilityState={{ expanded: pickerOpen, disabled: demo.busy }}
          disabled={demo.busy}
          onPress={openPicker}
          style={[s.formRow, s.dateRow]}
        >
          <Body style={s.rowLabel}>Дата рождения</Body>
          <View style={s.dateContent}>
            <Body style={s.dateValue}>{dateLabel}</Body>
            <Icon name="chevron-forward" size={18} color={authColors.muted} />
          </View>
        </Pressable>
      </View>
      {birthDate && !pickerOpen ? (
        <Pressable
          testID="birthday-clear"
          accessibilityRole="button"
          accessibilityLabel="Очистить дату рождения"
          onPress={() => {
            setBirthDate(null);
            setPickerOpen(false);
          }}
          style={s.later}
        >
          <Body style={s.clearText}>Очистить дату рождения</Body>
        </Pressable>
      ) : null}
      {dateError ? (
        <Body testID="birthday-error" style={s.error}>
          {dateError}
        </Body>
      ) : null}
      {nameLength > 32 ? <Body style={s.error}>Никнейм - не больше 32 символов.</Body> : null}

      <View style={s.field}>
        <Caption style={s.label}>ПОЛ · ОБЯЗАТЕЛЬНО</Caption>
        <View style={[s.genderRow, fontScale > 1.3 && { flexDirection: 'column' }]}>
          {(
            [
              { value: 'female', label: 'Женский' },
              { value: 'male', label: 'Мужской' },
            ] as const
          ).map((item) => (
            <Pressable
              key={item.value}
              testID={`profile-gender-${item.value}`}
              accessibilityRole="button"
              accessibilityState={{ selected: gender === item.value, disabled: demo.busy }}
              disabled={demo.busy}
              onPress={() => setGender(item.value)}
              style={({ pressed }) => [
                s.gender,
                gender === item.value && s.selectedOption,
                pressed && s.pressed,
              ]}
            >
              <Body style={s.genderText}>{item.label}</Body>
              {gender === item.value ? <Icon name="checkmark" color="#FFFFFF" size={16} /> : null}
            </Pressable>
          ))}
        </View>
      </View>

      {!demo.account && demo.ready ? (
        <Pressable accessibilityRole="button" onPress={() => props.navigate('M02')} style={s.later}>
          <Body style={s.clearText}>Войти по номеру телефона</Body>
        </Pressable>
      ) : null}
      {submitted && demo.error ? (
        <Body testID="profile-save-error" style={s.error}>
          {demo.error}
        </Body>
      ) : null}
    </AuthLayout>
  );
}

const s = StyleSheet.create({
  group: {
    marginTop: 28,
    borderRadius: 18,
    backgroundColor: authColors.surface,
    borderWidth: 1,
    borderColor: '#203561',
    overflow: 'hidden',
  },
  formRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 60,
    paddingHorizontal: 16,
    paddingVertical: 8,
    flexWrap: 'wrap',
  },
  rowLabel: { fontFamily: font.body, fontSize: 14, color: authColors.muted },
  nicknameInput: {
    flex: 1,
    minWidth: 100,
    textAlign: 'right',
    paddingVertical: 8,
    paddingHorizontal: 0,
    color: authColors.text,
    fontFamily: font.heading,
    fontSize: 17,
    lineHeight: 24,
    textAlignVertical: 'center',
    includeFontPadding: false,
  },
  dateRow: { borderTopWidth: 1, borderTopColor: '#203561' },
  dateContent: {
    flex: 1,
    minWidth: 100,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 6,
  },
  dateValue: {
    flexShrink: 1,
    lineHeight: 24,
    includeFontPadding: false,
    textAlign: 'right',
    fontFamily: font.heading,
    fontSize: 17,
    color: authColors.text,
  },
  field: { gap: 8, marginTop: 24 },
  label: {
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: 19,
    letterSpacing: 0.65,
    color: authColors.muted,
  },
  genderRow: {
    flexDirection: 'row',
    padding: 4,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#203561',
    backgroundColor: authColors.surface,
  },
  gender: {
    flex: 1,
    minHeight: 48,
    padding: 8,
    gap: 8,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 14,
  },
  selectedOption: { backgroundColor: '#1D3D7D' },
  genderText: {
    flexShrink: 1,
    fontFamily: font.medium,
    fontSize: 14,
    lineHeight: 22,
    color: authColors.text,
  },
  clearText: { fontSize: 13, color: authColors.muted },
  error: { fontSize: 13, lineHeight: 20, color: authColors.danger, marginTop: 12 },
  later: { minHeight: 48, paddingVertical: 10, justifyContent: 'center', alignItems: 'center' },
  laterText: { fontFamily: font.medium, fontSize: 14, lineHeight: 22, color: authColors.muted },
  pressed: { opacity: 0.75 },
});
