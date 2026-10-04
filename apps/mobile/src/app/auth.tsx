import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Animated, Easing, Keyboard, StyleSheet, View } from 'react-native';
import { useReducedMotion } from '../components/Motion';
import { OrderSheet } from '../components/OrderSheet';
import { AuthWelcome } from '../components/AuthWelcome';
import { Phone, Otp } from '../screens/AuthScreens';
import { Onboarding } from '../screens/RegistrationScreen';
import { Legal, Support } from '../screens/ProfileScreens';
import { AuthFlowContext } from '../auth-flow';
import { accountDestination } from '../account-access';
import { useAccount } from '../useAccount';
import { useMobile } from '../store';
import type { ScreenId, ScreenProps } from '../model';

export default function Auth() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const destination = accountDestination(params.returnTo);
  const preview = params.preview === '1';
  const account = useAccount();
  const onboardingEntered = useRef(false);
  const model = useMobile(preview);
  const [step, setStep] = useState<ScreenId>(
    ['M02', 'M03', 'M04'].includes(String(params.step)) ? (String(params.step) as ScreenId) : 'M01',
  );
  const [auxiliary, setAuxiliary] = useState<ScreenId | null>(null);
  const reducedMotion = useReducedMotion();
  const transition = useRef(new Animated.Value(1)).current;
  const transitioning = useRef(false);
  const [changingStep, setChangingStep] = useState(false);
  useEffect(() => () => transition.stopAnimation(), [transition]);
  useEffect(() => {
    if (step === 'M01' || !transitioning.current) return;
    const animation = Animated.timing(transition, {
      toValue: 1,
      duration: reducedMotion ? 100 : 200,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (!finished) return;
      transitioning.current = false;
      setChangingStep(false);
    });
    return () => animation.stop();
  }, [step, transition, reducedMotion]);
  const [accepted, setAccepted] = useState<{ phone: string; version: string } | null>(null);
  const dismiss = useCallback(() => {
    Keyboard.dismiss();
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/menu');
  }, [router]);
  const finished = useRef(false);
  const finish = useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    if (preview) {
      dismiss();
      return;
    }
    Keyboard.dismiss();
    if (destination === 'M12') router.dismissTo('/checkout');
    else if (destination === 'M30') router.dismissTo('/(tabs)/profile');
    else if (destination === 'M26') router.dismissTo('/(tabs)/events');
    else if (destination === 'M19') router.dismissTo('/(tabs)/orders');
    else if (destination === 'pick-man') router.dismissTo('/games/pick-man');
    else if (destination === 'pick-blocks') router.dismissTo('/games/pick-blocks');
    else if (destination === 'magic-sort') router.dismissTo('/games/magic-sort');
    else if (destination === 'pick-farm') router.dismissTo('/games/pick-farm');
    else if (destination)
      router.dismissTo({ pathname: '/screen/[id]', params: { id: destination } });
    else dismiss();
  }, [destination, dismiss, preview, router]);
  useEffect(() => {
    if (
      preview ||
      step !== 'M04' ||
      !account.ready ||
      !account.account ||
      onboardingEntered.current
    )
      return;
    // Skip the form only for an already completed profile on entry. Once shown,
    // background account refresh must never close the user's unfinished form.
    onboardingEntered.current = true;
    if (account.account.profile.completedAt != null) finish();
  }, [step, account.ready, account.account, preview, finish]);
  const navigate = (id: ScreenId) => {
    if (id === 'M06' || id === 'M30') {
      finish();
      return;
    }
    if (id === 'M31' || id === 'M33') {
      Keyboard.dismiss();
      setAuxiliary(id);
      return;
    }
    if (id === 'M02' || id === 'M03' || id === 'M04') {
      if (transitioning.current) return;
      if (step === 'M01') {
        transitioning.current = true;
        setChangingStep(true);
        Animated.timing(transition, {
          toValue: 0,
          duration: reducedMotion ? 80 : 100,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }).start(({ finished }) => {
          if (finished) setStep(id);
        });
        return;
      }
      setStep(id);
      return;
    }
  };
  return (
    <AuthFlowContext.Provider
      value={{
        destination,
        accepted,
        readyForInput: !changingStep,
        accept: (phone, version) => setAccepted({ phone, version }),
      }}
    >
      <OrderSheet auth name="Вход в PickChick" onClose={dismiss}>
        {(close) => {
          const props: ScreenProps = {
            screenId: step,
            model,
            navigate,
            goBack: close,
            preview,
            inSheet: true,
          };
          return (
            <View style={{ flex: 1 }}>
              <Animated.View
                testID="auth-step-transition"
                pointerEvents={changingStep ? 'none' : 'auto'}
                style={{
                  flex: 1,
                  opacity: transition,
                  transform: [
                    {
                      translateX: reducedMotion
                        ? 0
                        : transition.interpolate({
                            inputRange: [0, 1],
                            outputRange: [step === 'M01' ? -16 : 16, 0],
                          }),
                    },
                  ],
                }}
                accessibilityElementsHidden={!!auxiliary}
                importantForAccessibility={auxiliary ? 'no-hide-descendants' : 'auto'}
                aria-hidden={!!auxiliary}
              >
                {step === 'M01' ? (
                  <AuthWelcome {...props} />
                ) : step === 'M02' ? (
                  <Phone {...props} />
                ) : step === 'M03' ? (
                  <Otp {...props} />
                ) : (
                  <Onboarding {...props} />
                )}
              </Animated.View>
              {auxiliary ? (
                <View style={[StyleSheet.absoluteFill, { backgroundColor: '#04143A' }]}>
                  {auxiliary === 'M33' ? (
                    <Legal {...props} screenId="M33" goBack={() => setAuxiliary(null)} />
                  ) : (
                    <Support {...props} screenId="M31" goBack={() => setAuxiliary(null)} />
                  )}
                </View>
              ) : null}
            </View>
          );
        }}
      </OrderSheet>
    </AuthFlowContext.Provider>
  );
}
