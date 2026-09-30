export function createRequestEpoch() {
  let epoch = 0;
  return {
    begin() {
      epoch += 1;
      return epoch;
    },
    invalidate() {
      epoch += 1;
      return epoch;
    },
    isCurrent(requestId) {
      return requestId === epoch;
    },
  };
}
