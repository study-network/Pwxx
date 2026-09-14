export function useDevToolsDetection() {
  return { detected: false, strikes: 0, dismiss: () => {} };
}
