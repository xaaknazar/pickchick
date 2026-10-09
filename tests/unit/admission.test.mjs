import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Admission } from '../../packages/platform/dist/admission.js';
const { Subject } = createRequire(new URL('../../packages/platform/package.json', import.meta.url))(
  'rxjs',
);
const context = (name, method) => ({
  getClass: () => ({ name }),
  getHandler: () => ({ name: method }),
  switchToHttp: () => ({ getResponse: () => ({ setHeader() {} }) }),
});

test('256 public menu watches use a separate bounded bucket, leaving command capacity free', () => {
  const admission = new Admission(1);
  const subjects = [];
  for (let index = 0; index < 256; index++) {
    const subject = new Subject();
    subjects.push(subject);
    admission
      .intercept(context('CustomerCheckoutController', 'availability'), { handle: () => subject })
      .subscribe();
  }
  assert.equal(admission.catalogWatches, 256);
  assert.equal(admission.active, 0);
  let rejected;
  admission
    .intercept(context('CustomerCheckoutController', 'availability'), {
      handle: () => new Subject(),
    })
    .subscribe({
      error: (error) => {
        rejected = error;
      },
    });
  assert.equal(rejected.getStatus(), 503);
  const command = new Subject();
  admission
    .intercept(context('CustomerCheckoutController', 'quote'), { handle: () => command })
    .subscribe();
  assert.equal(admission.active, 1);
  command.complete();
  for (const subject of subjects) subject.complete();
  assert.equal(admission.active, 0);
  assert.equal(admission.catalogWatches, 0);
});
