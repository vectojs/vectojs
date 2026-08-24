/** Build the `AbortError` thrown on every cancellation path. Shared by the
 *  export session and the ffmpeg supervisor — byte-identical duplicates used
 *  to be maintained in both files (#661). The abort `reason` becomes the
 *  message when it is an Error or a string; a missing reason falls back to
 *  'Export aborted'. */
export function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  const error = new Error(
    reason instanceof Error ? reason.message : reason == null ? 'Export aborted' : String(reason),
    { cause: reason },
  );
  error.name = 'AbortError';
  return error;
}
