// The customer app never routes to the QA payment simulator by default.
// Opt in explicitly when exporting/running a separate internal test client.
export const orderSimulatorEnabled = process.env.EXPO_PUBLIC_ORDER_SIMULATOR === '1';
