/** Vite's `?raw` imports: a file's text (unit tests only; the worker bundle never imports one). */
declare module '*?raw' {
  const text: string;
  export default text;
}
