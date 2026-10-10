// Include workforce checks in the existing back-office CI suite without changing
// package scripts owned by the concurrent device-access task.
import '../../packages/backoffice-core/tests/workforce.test.mjs';
import '../../packages/backoffice-core/tests/workforce-store.test.mjs';
