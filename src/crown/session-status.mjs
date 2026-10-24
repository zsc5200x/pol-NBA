const REJECTED_MESSAGES = new Set([
  'expired', 'session expired', 'session_expired', 'session_rejected',
  'invalid session', 'invalid_session', 'doublelogin',
]);

// Only explicit server session markers count as logout. Unknown XML, maintenance
// pages and transport failures must not invalidate a saved login.
export function isSessionRejectedResponse(root) {
  const response = root?.serverresponse;
  return Boolean(response && typeof response === 'object' && !Array.isArray(response)
    && typeof response.msg === 'string' && REJECTED_MESSAGES.has(response.msg.trim().toLowerCase()));
}
