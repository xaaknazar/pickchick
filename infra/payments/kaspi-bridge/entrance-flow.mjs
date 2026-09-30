// Stateful adapter for the upstream entrance routes. No financial operations.
// Password payload follows KPEnterLoginPasswordPage in Kaspi's public entrance
// app.de20fd73.js (2026-09-29). Unknown challenges are never skipped.
const STEPS = {
  phone: ['KPUniversalEnterPhoneNumber', 'EnterPhoneNumber'],
  password: ['KPEnterLoginPassword', 'ViewEnterLoginPassword'],
  sms: ['EnterOtp', 'ViewEnterOtp'],
};
const ERROR_CODES = new Set([
  'OldVersionToUpdate',
  'AccountTemporaryBlocked',
  'AccountAlreadyTemporaryBlocked',
  'OtpAttemptsExceeded',
]);

export class EntranceFlow {
  constructor({ init, submit, finish, now = Date.now, ttlMs = 10 * 60_000 }) {
    Object.assign(this, { init, submit, finish, now, ttlMs });
    this.session = null;
    this.busy = false;
  }

  remember(body) {
    const session = this.session;
    const error = body?.error?.code ?? body?.view?.onOpenAlarm?.error?.code;
    if (!body || body.isClosed || body.actType === 'Alarm' || body.type === 'Alarm' || error) {
      this.session = null;
      return {
        success: false,
        nextStep: 'stopped',
        errorCode: ERROR_CODES.has(error) ? error : 'ENTRANCE_REJECTED',
      };
    }
    if (body.view?.code === 'UniversalKaspiIdTakePhoto') {
      this.session = null;
      return {
        success: false,
        nextStep: 'identity_verification',
        errorCode: 'KASPI_ID_REQUIRED',
      };
    }
    const step = Object.entries(STEPS).find(
      ([, [view, sn]]) => body.view?.code === view && body.meta?.sn === sn,
    )?.[0];
    if (
      !step ||
      !/^[A-Za-z0-9-]{8,128}$/.test(session.processId ?? '') ||
      body.meta?.pId !== session.processId
    ) {
      this.session = null;
      return { success: false, nextStep: 'unsupported', errorCode: 'ADDITIONAL_CONFIRMATION' };
    }
    session.meta = { pId: body.meta.pId, sn: body.meta.sn };
    session.step = step;
    return {
      success: step === 'sms',
      processId: session.processId,
      nextStep: step,
      view: body.view.code,
    };
  }

  async start() {
    if (this.busy) throw new Error('ENTRANCE_BUSY');
    this.busy = true;
    // One active process: upstream finish uses a single ephemeral ECDH key.
    this.session = null;
    try {
      const { session, body } = await this.init();
      this.session = { ...session, createdAt: this.now(), attempted: new Set() };
      const result = this.remember(body);
      return { ...result, success: result.nextStep === 'phone' };
    } catch {
      this.session = null;
      throw new Error('ENTRANCE_INIT_FAILED');
    } finally {
      this.busy = false;
    }
  }

  async credential(step, processId, value) {
    const session = this.session;
    if (this.busy) throw new Error('ENTRANCE_BUSY');
    if (!session || session.processId !== processId) throw new Error('PROCESS_INVALID');
    if (this.now() - session.createdAt >= this.ttlMs) {
      this.session = null;
      throw new Error('PROCESS_EXPIRED');
    }
    if (session.step !== step || session.attempted.has(step)) throw new Error('CHALLENGE_MISMATCH');
    const valid =
      typeof value === 'string' &&
      (step === 'phone'
        ? /^7[0-9]{9}$/.test(value)
        : step === 'password'
          ? value.trim().length > 0 && value.length <= 256
          : step === 'sms' && /^[0-9]{4,8}$/.test(value));
    if (!valid) throw new Error('CREDENTIAL_INVALID');
    const data =
      step === 'phone'
        ? { phoneNumber: value }
        : step === 'password'
          ? { password: value }
          : { userOtp: value, inputType: 'manual' };
    if (step === 'phone') session.phoneNumber = value;
    session.attempted.add(step);
    this.busy = true;
    try {
      const body = await this.submit(session, { meta: session.meta, data, actType: 'Success' });
      // KPMobileCall is the web-to-native bridge, not a telephone call. Kaspi's
      // public page invokes onRegister only for kpDeviceRegistration. Other
      // native actions and identity verification must never invoke finish.
      if (
        step === 'sms' &&
        !body?.isClosed &&
        body?.actType !== 'Alarm' &&
        body?.type !== 'Alarm' &&
        !body?.error &&
        !body?.view?.onOpenAlarm &&
        (body?.meta?.pId === undefined || body.meta.pId === session.processId) &&
        (!body?.view?.code || body.view.code === 'KPMobileCall') &&
        body?.data?.type === 'kpDeviceRegistration'
      ) {
        const result = await this.finish(session);
        this.session = null;
        return { ...result, success: true, nextStep: 'finished' };
      }
      return this.remember(body);
    } catch {
      this.session = null;
      // A lost answer is not permission to resubmit the password or OTP.
      throw new Error('ENTRANCE_REQUEST_FAILED');
    } finally {
      this.busy = false;
    }
  }
}
