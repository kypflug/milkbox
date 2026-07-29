/**
 * Azure app registration for Milkbox.
 *
 * Registered in the Azure portal as a SPA (personal Microsoft accounts only)
 * with redirect URIs http://localhost:5173/ and https://milkbox.stuntcamp.app/.
 * The client ID is public by design — auth code + PKCE, no secret.
 */
export const CLIENT_ID = '2746e456-8b09-4d41-94df-564b79d791ed';

/** localStorage key for our own account marker (iOS recovery). */
export const ACCOUNT_HINT_KEY = 'milkbox:account-hint';
