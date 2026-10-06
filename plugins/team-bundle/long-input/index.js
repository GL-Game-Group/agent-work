// @ts-check
/**
 * 长输入, Host half: nothing runs on the Host. The row exists so the Loader
 * serves this package's client module (client.js), which grows the Session's
 * composer to fill the conversation for long prompts.
 */

export const name = 'agent-work-long-input'

export function apply() {}
