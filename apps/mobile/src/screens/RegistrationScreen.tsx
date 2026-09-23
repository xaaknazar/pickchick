import { MotionPressable as Pressable } from '../components/Motion';
import { useEffect, useRef, useState } from 'react';
import { Keyboard, StyleSheet, TextInput, View, useWindowDimensions } from 'react-native';
import type { ScreenProps } from '../model';
import { useAccount } from '../useAccount';
import { formatDemoPhone } from '../demo-account';
import { isValidBirthDate, type DemoProfileInput } from '../profile-details';
import { font } from '../theme';
import { AuthButton, AuthLayout, authColors } from '../components/AuthLayout';
import { Body, Caption, Icon } from '../components/UI';
import BirthDatePicker from '../components/BirthDatePicker';

const months = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
];
function partsOf(value: string | null | undefined) {
  const [year, month, day] = value?.split('-').map(Number) ?? [];
  return { day: day ?? null, month: month ?? null, year: year ?? null };
}

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
  const date = partsOf(birthDate);
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
    Boolean(demo.account) &&
    !props.preview &&
    !dateError &&
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
      subtitle="Добавьте никнейм и дату рождения, чтобы мы познакомились поближе."
      footer={
        <>
          <AuthButton
            title={demo.busy ? 'Сохраняем…' : editing ? 'Сохранить' : 'Сохранить и продолжить'}
            testID="nickname-save"
            disabled={!canSave}
            onPress={() => void save()}
          />
          <Pressable
            testID="profile-fill-later"
            accessibilityRole="button"
            disabled={demo.busy}
            accessibilityState={{ disabled: demo.busy }}
            onPress={() => {
              Keyboard.dismiss();
              props.navigate(editing ? 'M30' : 'M06');
            }}
            style={({ pressed }) => [s.later, pressed && s.pressed]}
          >
            <Body style={s.laterText}>{editing ? 'Отмена' : 'Заполню позже'}</Body>
          </Pressable>
        </>
      }
    >
      <View style={s.field}>
        <Caption style={s.label}>НИКНЕЙМ</Caption>
        <View style={s.nicknameBox}>
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
            placeholder="pick_chick"
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
        {nameLength > 32 ? <Body style={s.error}>Никнейм - не больше 32 символов.</Body> : null}
      </View>

      <View style={s.field}>
        <Caption style={s.label}>НОМЕР ТЕЛЕФОНА</Caption>
        <View style={s.phoneBox}>
          <Body style={s.phoneText}>
            {demo.account ? formatDemoPhone(demo.account.phone) : 'Сначала войдите по номеру'}
          </Body>
          <Icon name="phone-portrait-outline" color={authColors.muted} size={18} />
        </View>
      </View>

      <View style={s.field}>
        <View style={s.labelRow}>
          <Caption style={s.label}>ДАТА РОЖДЕНИЯ</Caption>
          {birthDate ? (
            <Pressable
              testID="birthday-clear"
              accessibilityRole="button"
              accessibilityLabel="Очистить дату рождения"
              disabled={demo.busy}
              onPress={() => {
                setBirthDate(null);
                setPickerOpen(false);
                setSubmitted(false);
              }}
              style={({ pressed }) => [s.clear, pressed && s.pressed]}
            >
              <Body style={s.clearText}>Очистить</Body>
            </Pressable>
          ) : null}
        </View>
        <View style={s.dateRow}>
          {(
            [
              { key: 'day', label: 'День', flex: 1, value: date.day },
              {
                key: 'month',
                label: 'Месяц',
                flex: 1.8,
                value: date.month ? months[date.month - 1] : null,
              },
              { key: 'year', label: 'Год', flex: 1.2, value: date.year },
            ] as const
          ).map((part) => (
            <Pressable
              key={part.key}
              testID={`birthday-${part.key}`}
              accessibilityRole="button"
              accessibilityLabel={`${part.label} рождения: ${part.value ?? 'не выбрано'}`}
              accessibilityState={{ expanded: pickerOpen, disabled: demo.busy }}
              disabled={demo.busy}
              onPress={openPicker}
              style={({ pressed }) => [
                s.datePart,
                { flex: part.flex },
                pickerOpen && s.selectedBorder,
                pressed && s.pressed,
              ]}
            >
              <Caption style={s.datePartLabel}>{part.label}</Caption>
              <Body
                style={[
                  s.dateValue,
                  part.key === 'month' && s.monthValue,
                  !part.value && s.placeholder,
                ]}
              >
                {part.value ?? '-'}
              </Body>
            </Pressable>
          ))}
        </View>
        {pickerOpen ? (
          <BirthDatePicker
            value={birthDate}
            onConfirm={(selected) => {
              setBirthDate(selected);
              setPickerOpen(false);
              setSubmitted(false);
            }}
            onCancel={() => setPickerOpen(false)}
          />
        ) : null}
        {dateError && !pickerOpen ? (
          <Body testID="birthday-error" style={s.error}>
            {dateError}
          </Body>
        ) : null}
      </View>

      <View style={s.field}>
        <Caption style={s.label}>ПОЛ · НЕОБЯЗАТЕЛЬНО</Caption>
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
              onPress={() => setGender((previous) => (previous === item.value ? null : item.value))}
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

      <View style={s.rewardNote}>
        <View style={s.orangeDot} />
        <Body style={s.rewardText}>
          Подарки ко дню рождения появятся вместе с программой Чиков.
        </Body>
      </View>
      <Caption style={s.localNote}>
        {demo.mode === 'server'
          ? 'Данные профиля сохраняются в вашем аккаунте Pick Chick.'
          : 'Данные этого тестового профиля сохраняются только на вашем устройстве.'}
      </Caption>
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
  field: { gap: 8, marginTop: 16 },
  label: {
    fontFamily: font.medium,
    fontSize: 12.5,
    lineHeight: 19,
    letterSpacing: 0.65,
    color: '#93A6C9',
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 28,
    flexWrap: 'wrap',
    gap: 8,
  },
  nicknameBox: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
    paddingHorizontal: 18,
    borderRadius: 16,
    backgroundColor: '#0A2050',
    minHeight: 60,
  },
  nicknameInput: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 14,
    paddingHorizontal: 0,
    color: '#F2F6FF',
    fontFamily: font.heading,
    fontSize: 19,
    lineHeight: 28,
    includeFontPadding: false,
  },
  phoneBox: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingVertical: 15,
    borderRadius: 16,
    backgroundColor: '#123068',
    minHeight: 58,
  },
  phoneText: { flex: 1, fontFamily: font.heading, fontSize: 19, lineHeight: 28, color: '#F2F6FF' },
  dateRow: { flexDirection: 'row', gap: 10 },
  datePart: {
    minWidth: 0,
    minHeight: 76,
    gap: 3,
    paddingHorizontal: 11,
    paddingVertical: 11,
    borderWidth: 2,
    borderColor: 'transparent',
    borderRadius: 16,
    backgroundColor: '#0A2050',
  },
  datePartLabel: { fontSize: 11, lineHeight: 16, color: '#93A6C9' },
  dateValue: { fontFamily: font.heading, fontSize: 19, lineHeight: 28, color: '#F2F6FF' },
  monthValue: { fontSize: 17 },
  selectedBorder: { borderColor: '#2E6FE8' },
  placeholder: { color: '#93A6C9' },
  clear: {
    minHeight: 48,
    flexShrink: 0,
    justifyContent: 'center',
    paddingLeft: 12,
  },
  clearText: { fontSize: 13, lineHeight: 19, fontFamily: font.medium, color: '#9DC0FF' },
  selectedOption: { backgroundColor: '#2E6FE8', borderColor: '#2E6FE8' },
  genderRow: { flexDirection: 'row', gap: 10 },
  gender: {
    flex: 1,
    minHeight: 54,
    padding: 10,
    gap: 8,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
    borderRadius: 16,
    backgroundColor: '#0A2050',
  },
  genderText: {
    flexShrink: 1,
    fontFamily: font.medium,
    fontSize: 15.5,
    lineHeight: 24,
    color: '#F2F6FF',
  },
  rewardNote: {
    marginTop: 16,
    backgroundColor: '#3A1A0B',
    borderRadius: 16,
    padding: 16,
    gap: 11,
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  orangeDot: { width: 8, height: 8, marginTop: 6, borderRadius: 4, backgroundColor: '#FF7A3D' },
  rewardText: { flex: 1, fontSize: 13, lineHeight: 21, color: '#F2F6FF' },
  localNote: { marginTop: 12, fontSize: 12, lineHeight: 19, color: '#93A6C9' },
  error: { fontSize: 13, lineHeight: 20, color: '#FFB0AB' },
  later: { minHeight: 44, paddingVertical: 10, justifyContent: 'center', alignItems: 'center' },
  laterText: { fontFamily: font.medium, fontSize: 15, lineHeight: 22, color: '#93A6C9' },
  pressed: { opacity: 0.75 },
});
