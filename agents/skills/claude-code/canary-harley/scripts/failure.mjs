/**
 * canary-harley -- a refusal: the exit code and the one line that says why.
 *
 * Messages carry type text, paths and ids. Each is made one inert line here,
 * where it is built, so every reader of `error.message` is covered.
 */
import { safe } from './safe.mjs';

export const EXIT_USAGE = 2;
export const EXIT_ABSTAINED = 3;

const MESSAGE_MAX = 2000;

/**
 * @param {number} exit
 * @param {string} message may hold text from the analysed file or argv
 * @returns {{ exit: number, message: string }}
 */
export const fail = (exit, message) => ({
  exit,
  message: safe(message, MESSAGE_MAX),
});
