// Exact Crown sites confirmed for this project. Credentials stay bound to the
// origin that produced the member heartbeat, including after a login redirect.
export const CROWN_ORIGINS = Object.freeze([
  'https://m321.mos077.com',
  'https://m829.crw066.com',
]);
export const LOGIN_ORIGIN = 'https://m829.crw066.com';

export const isCrownOrigin = origin => CROWN_ORIGINS.includes(origin);
export const crownEndpointForOrigin = origin => isCrownOrigin(origin) ? `${origin}/transform.php` : null;
export const isCrownEndpoint = endpoint => CROWN_ORIGINS.some(origin => endpoint === crownEndpointForOrigin(origin));
