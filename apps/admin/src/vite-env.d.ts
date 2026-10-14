/// <reference types="vite/client" />
interface ImportMetaEnv {
  /** Origin of the player site, used to display password-reset links. */
  readonly VITE_USER_ORIGIN?: string;
}
