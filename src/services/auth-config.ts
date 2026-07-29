/**
 * Azure app registration for Milkbox.
 *
 * Registered in the Azure portal as a SPA (personal Microsoft accounts only)
 * with redirect URIs http://localhost:5173/ and https://milkbox.stuntcamp.app/.
 * The client ID is public by design — auth code + PKCE, no secret.
 */
export const CLIENT_ID = '9b7c7443-27bd-4158-99d5-0163198cb949';

/** localStorage key for our own account marker (iOS recovery). */
export const ACCOUNT_HINT_KEY = 'milkbox:account-hint';
