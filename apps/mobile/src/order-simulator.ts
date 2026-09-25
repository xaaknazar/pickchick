// Explicit internal-test switches; release ordering stays disabled by default.
export const orderSimulatorEnabled = process.env.EXPO_PUBLIC_ORDER_SIMULATOR === '1';
export const unpaidTestOrdersEnabled = process.env.EXPO_PUBLIC_UNPAID_TEST_ORDERS === '1';
export const connectedTestOrdersEnabled = orderSimulatorEnabled || unpaidTestOrdersEnabled;
